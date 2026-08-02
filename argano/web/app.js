/* argano, the interface.
 *
 * Plain browser JavaScript: no modules, no bundler, no dependencies. Open the
 * file, change a line, reload the window. That costs a few extra lines here
 * and saves anyone who forks the project from installing a toolchain to move
 * a button.
 *
 * The shape of the app is a queue of one. A file is opened, looked at, and
 * either repaired or dropped. So there is no router and no store, just four
 * screens and the small amount of state that moves between them.
 */

const $ = (id) => document.getElementById(id);

const state = {
  path: null,          // the damaged file
  diagnosis: null,     // what /api/inspect said about it
  reference: null,     // the working file its settings are read from
  job: null,           // id of the running repair
  poll: null,          // timeout handle for the next poll
  clock: null,         // interval handle for the elapsed counter
  startedAt: 0,
  misses: 0,           // polls in a row that did not come back
};

/* The stages the repair reports, in the order they happen, with the words a
   person would use for them. The weights are how much of the wall clock each
   stage tends to take on a long file: they turn six separate fractions into
   one number that keeps moving forwards. They are an estimate and the screen
   says so, since the scan is the only stage whose length is known in advance. */
const STAGES = [
  { id: "inspect", label: "Read the file", weight: 3 },
  { id: "scan", label: "Find the frames", weight: 40 },
  { id: "audio", label: "Split the sound into frames", weight: 15 },
  { id: "timeline", label: "Put the frames back on a clock", weight: 4 },
  { id: "write", label: "Write the repaired copy", weight: 26 },
  { id: "verify", label: "Check the result", weight: 12 },
];
const TOTAL_WEIGHT = STAGES.reduce((sum, s) => sum + s.weight, 0);

/* ---------------- talking to the server ---------------- */

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body, or not JSON */ }
  // The API reports trouble two ways: an HTTP status, or a 200 carrying an
  // `error` string. Both end up as one thrown Error with the status attached.
  if (!res.ok || (data && data.error)) {
    const err = new Error((data && (data.error || data.detail)) || res.statusText || "request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- formatting ---------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const basename = (p) => String(p || "").split("/").pop() || String(p || "");

const count = (n) => Number(n || 0).toLocaleString("en-GB");

/* Decimal units, the ones a file manager shows, so the numbers here agree with
   the numbers in Finder. Gigabytes get two decimals: a file of 1.28 GB with
   1.26 GB of media inside it would otherwise read as 1.3 GB twice over, and
   the whole point of that line is the difference between the two. */
function bytes(n) {
  const value = Number(n || 0);
  if (value < 1000) return `${value} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let scaled = value / 1000;
  let i = 0;
  while (scaled >= 1000 && i < units.length - 1) { scaled /= 1000; i++; }
  const places = scaled >= 10 ? 0 : i >= 2 ? 2 : 1;
  return `${scaled.toFixed(places)} ${units[i]}`;
}

/* Durations read as 15m 36s, 1h 04m 12s, 42s. Padding the middle unit keeps
   the numbers from jumping about while the elapsed clock counts. */
function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

const sentence = (s) => {
  const text = String(s || "").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
};

const percent = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

function share(part, whole) {
  const p = percent(part, whole);
  if (p > 0 && p < 0.1) return "under 0.1%";
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

/* Track descriptions arrive as `vide:avc1`. The four letter codes are how the
   file format writes them down, and nobody outside this project reads them. */
const HANDLERS = { vide: "picture", soun: "sound", sbtl: "subtitles", text: "text", meta: "data" };
const CODECS = {
  avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC",
  mp4a: "AAC", sowt: "PCM", twos: "PCM", lpcm: "PCM", "raw ": "PCM", in24: "PCM", fl32: "PCM",
};

function trackWords(track) {
  const [handler, codec] = String(track || "").split(":");
  const kind = HANDLERS[handler] || handler || "track";
  const name = CODECS[codec] || codec;
  return name ? `${kind} (${name})` : kind;
}

/* Box names, in the words used on the rest of the screen. */
const BOX_ROLE = {
  mdat: { role: "media", words: "the audio and video themselves" },
  moov: { role: "index", words: "the index that says where every frame starts" },
  ftyp: { role: "other", words: "a few bytes naming the file format" },
  free: { role: "other", words: "padding left by the recorder" },
  skip: { role: "other", words: "padding left by the recorder" },
  wide: { role: "other", words: "padding left by the recorder" },
  moof: { role: "other", words: "a fragment header" },
  mfra: { role: "other", words: "a fragment index" },
};
const roleOf = (name) => (BOX_ROLE[name] ? BOX_ROLE[name].role : "other");

/* ---------------- screens ---------------- */

const SCREENS = ["open", "diagnosis", "repair", "result"];

/* Swapping screens moves focus to the new one rather than to its main button.
   Landing on the button would scroll the page past the diagnosis to reach it,
   and a screen reader would start halfway down a page nobody has read yet. A
   section with tabindex="-1" puts the caret at the top of what just arrived. */
function show(name) {
  for (const id of SCREENS) $(`screen-${id}`).hidden = id !== name;
  $("start-over").hidden = name === "open";
  $("top-file").hidden = !state.path || name === "open";
  if (state.path) $("top-file").textContent = basename(state.path);
  clearAlert();
  window.scrollTo({ top: 0, behavior: "auto" });
  $(`screen-${name}`).focus({ preventScroll: true });
}

function fail(message) {
  $("alert-text").textContent = message;
  $("alert").hidden = false;
}

function clearAlert() {
  $("alert").hidden = true;
  $("alert-text").textContent = "";
}

/* ---------------- opening a file ---------------- */

/* The native shell hands the path in here after a drop on the window. It is
   the only entry point the packaged app uses. */
window.arganoDropped = function (path) {
  if (typeof path === "string" && path.trim()) openFile(path.trim());
};

async function browse(kind) {
  try {
    const answer = await post("/api/browse", { kind });
    return answer && answer.path ? answer.path : null;
  } catch (err) {
    // 501 means there is no native picker behind this window, which is the
    // normal state when the interface is opened in a browser rather than in
    // the app. Falling back to a path field is the whole handling.
    if (err.status === 501) {
      // The field for the damaged file lives on the first screen, so go back
      // there before asking for it. Unhiding a form on a hidden screen would
      // look like the button did nothing at all.
      if (kind !== "reference") show("open");
      showPaste(kind, "This window has no file picker of its own, so the location has to be pasted in.");
      return null;
    }
    throw err;
  }
}

function showPaste(kind, why) {
  const form = kind === "reference" ? $("paste-reference") : $("paste-damaged");
  form.hidden = false;
  if (kind === "damaged" && why) $("paste-damaged-why").textContent = why;
  form.querySelector("input").focus();
}

/* A path dragged from a terminal arrives with its spaces escaped, and one
   copied from a file manager can arrive wrapped in quotes or as a file: URL.
   All three are what the person meant, so all three are accepted. */
function cleanPath(raw) {
  let text = String(raw || "").trim();
  if (/^file:\/\//i.test(text)) {
    try { text = decodeURI(text.replace(/^file:\/\//i, "")); } catch (_) { /* keep it as it came */ }
  }
  text = text.replace(/^["']|["']$/g, "");
  text = text.replace(/\\ /g, " ");
  return text.trim();
}

async function openFile(path) {
  // A file dropped on the window in the middle of a repair would otherwise
  // throw away the screen that is reporting it.
  if (state.job) {
    fail("A repair is already running. Wait for it to finish, then open the next file.");
    return;
  }
  const button = $("pick-damaged");
  const wasLabelled = button.textContent;
  button.disabled = true;
  button.textContent = "Reading the file…";
  clearAlert();
  try {
    const diagnosis = await post("/api/inspect", { path });
    state.path = path;
    state.diagnosis = diagnosis;
    state.reference = null;
    renderDiagnosis(diagnosis);
    show("diagnosis");
  } catch (err) {
    fail(`That file could not be read: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = wasLabelled;
  }
}

/* ---------------- 2. diagnosis ---------------- */

function renderDiagnosis(dx) {
  const size = Number(dx.size || 0);
  const media = Number(dx.media_size || 0);

  $("dx-verdict").textContent = sentence(dx.verdict) || "Something is wrong with this file";
  $("dx-detail").textContent = dx.detail || "";

  const tracks = Array.isArray(dx.tracks) ? dx.tracks : [];
  const facts = [
    ["File", esc(basename(state.path))],
    ["Size", `${esc(bytes(size))} <span class="fine">(${esc(count(size))} bytes)</span>`],
    ["Media", `${esc(bytes(media))} <span class="fine">(${esc(share(media, size))} of the file)</span>`],
    ["Tracks", tracks.length
      ? esc(tracks.map(trackWords).join(", "))
      : `<span class="fine">none named, because the part that names them is gone</span>`],
  ];
  $("dx-facts").innerHTML = facts
    .map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`)
    .join("");

  renderStructure(dx, size, media);
  renderReference(dx);

  $("faststart").checked = false;
  updateRepairHint();
}

/* The bar is drawn strictly to scale: each box sits at its real offset and is
   as wide as it really is. That is the point of it. Anything the boxes do not
   cover stays as the empty track behind them, and a missing index has no
   width at all, so it is stated in the legend rather than given an invented
   block that would make the picture a lie. */
function renderStructure(dx, size, media) {
  const boxes = Array.isArray(dx.top_level) ? dx.top_level : [];

  $("dx-bar").innerHTML = boxes.map(([name, offset, length]) => {
    const left = percent(Number(offset || 0), size);
    const width = Math.max(percent(Number(length || 0), size), 0.15);
    return `<span class="seg is-${roleOf(name)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
  }).join("");

  const hasIndex = boxes.some(([name]) => name === "moov");
  // Three states, and the middle one is the reassuring one. A file with no
  // media at all must not be told that all of its frames are still there.
  let tail;
  if (!media) {
    tail = "There is no block of media in this file, so there is nothing here to index.";
  } else if (!dx.needs_reference) {
    tail = "The index beside it can still be read, so the file can describe itself.";
  } else {
    tail = "Every frame is still in there. What is missing is the index that says where each one starts, which is why nothing will play it.";
  }
  $("dx-read").innerHTML = `<b>${esc(share(media, size))} of this file is media.</b> ${esc(tail)}`;

  const kinds = [];
  const seen = new Set();
  for (const [name] of boxes) {
    if (seen.has(name)) continue;
    seen.add(name);
    const known = BOX_ROLE[name];
    kinds.push(`<li><span class="swatch is-${roleOf(name)}"></span><b>${esc(name)}</b> ${esc(known ? known.words : "part of the file's structure")}</li>`);
  }
  if (!hasIndex) {
    kinds.push(`<li><span class="swatch is-gone"></span><b>moov</b> the index, never written</li>`);
  }
  $("dx-legend").innerHTML = kinds.join("");

  $("dx-boxes").innerHTML = boxes.map(([name, offset, length]) => `
    <tr class="${roleOf(name) === "media" ? "is-media" : ""}">
      <td>${esc(name)}</td>
      <td>${esc(bytes(offset))}</td>
      <td>${esc(bytes(length))}</td>
      <td>${esc(share(Number(length || 0), size))}</td>
    </tr>`).join("");
}

function renderReference(dx) {
  const needed = Boolean(dx.needs_reference);
  $("ref-card").classList.toggle("is-needed", needed);
  $("ref-kicker").textContent = needed ? "Needed for this file" : "Optional for this file";
  $("ref-title").textContent = needed
    ? "Pick a working video to read the settings from"
    : "This file can describe itself";

  $("ref-why").textContent = needed
    ? "A recording that was never finalised has lost the part that says how the picture was "
      + "encoded, and those settings cannot be guessed from the bytes alone. argano reads them "
      + "from a video that still plays, then applies them to yours. The reference is only read, "
      + "and it is not copied into the result."
    : "The index in this file can still be read, so the settings are taken from the file itself. "
      + "Adding a reference is optional. It is worth doing if the repaired copy comes out with "
      + "the wrong colours or the wrong size.";

  $("ref-good").innerHTML = needed ? [
    "<b>The same camera or app</b> that made the damaged file.",
    "<b>The same recording setting</b>: the same resolution and frame rate, from the same mode or preset.",
    "<b>Any length.</b> Three seconds is enough, and a short clip is read faster.",
    "<b>Straight off the device.</b> A clip that other software has already exported describes that software, not your camera.",
  ].map((line) => `<li>${line}</li>`).join("") : "";

  setReference(null);
}

function setReference(path) {
  state.reference = path;
  $("ref-chosen").hidden = !path;
  if (path) {
    $("ref-name").textContent = basename(path);
    $("ref-name").title = path;
    $("pick-ref").textContent = "Choose a different one";
  } else {
    $("pick-ref").textContent = "Choose reference video";
  }
  updateRepairHint();
}

function updateRepairHint() {
  const needed = Boolean(state.diagnosis && state.diagnosis.needs_reference);
  const hint = $("repair-hint");
  if (needed && !state.reference) {
    hint.textContent = "A reference video is needed before this one can be repaired.";
    hint.classList.add("is-warning");
  } else {
    hint.textContent = "Your file is only read. The repaired copy is written beside it under a new name.";
    hint.classList.remove("is-warning");
  }
}

/* ---------------- 3. the repair ---------------- */

async function startRepair() {
  const needed = Boolean(state.diagnosis && state.diagnosis.needs_reference);
  // The button stays live in this case rather than going grey. A dead button
  // with no explanation is the worst version of this: the person is told no
  // and not told why. Sending them to the picker, with the reason spoken, is
  // the same protection and it moves them forwards.
  if (needed && !state.reference) {
    fail("This file needs a reference video first: it has nothing left in it that says how the picture was encoded.");
    $("pick-ref").focus();
    return;
  }

  const button = $("do-repair");
  button.disabled = true;
  try {
    const answer = await post("/api/repair", {
      path: state.path,
      reference: state.reference,
      faststart: $("faststart").checked,
    });
    state.job = answer.job;
    beginProgress();
    show("repair");
    pollOnce();
  } catch (err) {
    fail(`The repair could not be started: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

function beginProgress() {
  $("rp-title").textContent = basename(state.path);
  $("rp-pct").textContent = "0%";
  $("rp-bar").style.width = "0%";
  $("rp-track").setAttribute("aria-valuenow", "0");
  $("rp-note").textContent = "Starting";
  for (const item of $("rp-stages").children) {
    item.classList.remove("is-done", "is-active");
    item.removeAttribute("aria-current");
    item.querySelector(".stage-bar > i").style.width = "0%";
  }
  state.startedAt = Date.now();
  state.misses = 0;
  tickClock();
  state.clock = setInterval(tickClock, 1000);
}

function tickClock() {
  const seconds = (Date.now() - state.startedAt) / 1000;
  $("rp-elapsed").textContent = `${duration(seconds)} so far`;
}

function stopWork() {
  clearTimeout(state.poll);
  clearInterval(state.clock);
  state.poll = null;
  state.clock = null;
  state.job = null;
}

function pollOnce() {
  state.poll = setTimeout(async () => {
    if (!state.job) return;
    try {
      const res = await fetch(`/api/job/${encodeURIComponent(state.job)}`);
      const job = await res.json();
      state.misses = 0;
      if (job.state === "done") {
        stopWork();
        renderResult(job.result || {});
        show("result");
        return;
      }
      if (job.state === "error") {
        stopWork();
        show("diagnosis");
        fail(job.error || "The repair stopped without saying why.");
        return;
      }
      renderProgress(job);
    } catch (_) {
      // A local server drops the odd request while it is busy writing. Only a
      // run of failures means something is actually wrong.
      state.misses += 1;
      if (state.misses > 12) {
        stopWork();
        show("diagnosis");
        fail("The repair stopped answering. It may still be running in the background.");
        return;
      }
    }
    pollOnce();
  }, 400);
}

function renderProgress(job) {
  // "done" can arrive one poll before the job's state catches up with it.
  const finishing = job.stage === "done";
  const current = finishing ? STAGES.length : STAGES.findIndex((s) => s.id === job.stage);
  const fraction = Math.min(Math.max(Number(job.fraction) || 0, 0), 1);

  let passed = 0;
  $("rp-stages").querySelectorAll("li").forEach((item, i) => {
    // Anything before the stage now running has been passed, whether it
    // reported or not. Some files have no audio, and that stage never speaks.
    const done = current >= 0 && i < current;
    const active = i === current;
    item.classList.toggle("is-done", done);
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    item.querySelector(".stage-bar > i").style.width = active ? `${(fraction * 100).toFixed(1)}%` : "0%";
    if (done) passed += STAGES[i].weight;
  });

  const here = current >= 0 && current < STAGES.length ? STAGES[current].weight * fraction : 0;
  const overall = Math.min(((passed + here) / TOTAL_WEIGHT) * 100, 99);
  $("rp-pct").textContent = `${Math.floor(overall)}%`;
  $("rp-bar").style.width = `${overall.toFixed(1)}%`;
  $("rp-track").setAttribute("aria-valuenow", String(Math.floor(overall)));

  const note = job.note || (current >= 0 ? STAGES[current].label.toLowerCase() : "");
  if (note && $("rp-note").textContent !== sentence(note)) $("rp-note").textContent = sentence(note);
}

/* ---------------- 4. the result ---------------- */

function timingWords(model) {
  const value = String(model || "").trim();
  if (!value) return "the order the frames were written in";
  if (value === "audio-anchored") {
    return "the audio track <em>(each picture placed by the sound recorded beside it, which is the truest clock a file like this has)</em>";
  }
  if (value.startsWith("fixed")) {
    return `an even rate, ${esc(value.replace(/^fixed\s*/, ""))} <em>(there was no audio to follow, so the frames were spread evenly)</em>`;
  }
  if (value === "no video") return "no video track was found";
  return esc(value);
}

const DAMAGE_WORDS = {
  "unreadable-audio": "sound that could not be read",
  "unreadable-tail": "an unreadable stretch at the end of the media",
  garbage: "bytes that matched no frame",
};

function renderResult(result) {
  const report = result.report || {};
  const errors = normaliseFindings(report.errors);
  const warnings = normaliseFindings(report.warnings).concat(normaliseFindings(result.warnings));
  const damage = Array.isArray(result.damage) ? result.damage : [];
  const lost = Number(result.lost_seconds || 0);

  $("rs-kicker").textContent = errors.length ? "Finished, with problems" : "Finished";
  $("rs-kicker").classList.toggle("is-bad", errors.length > 0);
  $("rs-title").textContent = errors.length
    ? "Repaired, and worth checking"
    : damage.length
      ? "Repaired, with some loss"
      : "Repaired";
  $("rs-sub").textContent = errors.length
    ? "A new file was written. The checks found something that may stop it playing everywhere, so watch it through before you delete anything."
    : "A new file was written beside the original. Nothing was encoded again, so the picture and the sound are the ones you recorded.";

  const width = Number(result.width || report.width || 0);
  const height = Number(result.height || report.height || 0);
  const stats = [
    [duration(result.duration), "of video"],
    [count(result.video_frames), "video frames"],
    [count(result.audio_frames), "audio frames"],
    [width && height ? `${width}×${height}` : "unknown", "frame size"],
  ];
  $("rs-stats").innerHTML = stats
    .map(([value, name]) => `<li><span class="stat-value">${esc(value)}</span><span class="stat-name">${esc(name)}</span></li>`)
    .join("");

  $("rs-path").textContent = result.output || "";

  $("rs-findings").innerHTML = errors
    .map((m) => finding("error", m))
    .concat(warnings.map((m) => finding("warning", m)))
    .join("");

  renderLoss(damage, lost);

  $("rs-how").innerHTML = [
    ["Timing from", timingWords(result.timing_model)],
    ["Codec settings from", esc(result.profile_source || "the file itself")],
    ["Quality", "untouched. The media bytes in the new file are the media bytes from the old one."],
  ].map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("");
}

function finding(level, message) {
  const tag = level === "error" ? "Error" : "Warning";
  return `<div class="finding is-${level}"${level === "error" ? ' role="alert"' : ""}>
    <span class="finding-tag">${tag}</span><span>${esc(message)}</span>
  </div>`;
}

/* Findings come back either as plain sentences or as objects carrying a level
   and a message. Both shapes are read here so the page does not depend on
   which one the server happens to send. */
function normaliseFindings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : (item && (item.message || item.text)) || ""))
    .filter(Boolean);
}

/* Being specific about loss is the point of this block. A repair that quietly
   swallowed nine seconds of a wedding and reported success is worse than one
   that says which nine seconds went. */
function renderLoss(damage, lost) {
  const box = $("rs-loss");
  if (!damage.length) {
    box.innerHTML = `<h2 class="sub">What was lost</h2>
      <p class="loss-line"><b>Nothing.</b> Every byte of the media was read, and all of it is in the new file.</p>`;
    return;
  }

  const total = damage.reduce((sum, d) => sum + Number(d.length || 0), 0);
  const stretches = damage.length === 1 ? "one stretch" : `${count(damage.length)} stretches`;
  const cost = lost >= 1
    ? `That is about ${esc(duration(lost))} of the recording.`
    : lost > 0
      ? "That is under a second of the recording."
      : "";

  const rows = damage.slice(0, 12).map((d) => `
    <li>
      <span class="at">at ${esc(bytes(d.offset))}</span>
      <span class="len">${esc(bytes(d.length))}</span>
      <span class="what">${esc(DAMAGE_WORDS[d.kind] || d.kind || "unreadable")}</span>
    </li>`).join("");
  const more = damage.length > 12
    ? `<p class="fine">${esc(count(damage.length - 12))} shorter stretches are not listed.</p>`
    : "";

  box.innerHTML = `<h2 class="sub">What was lost</h2>
    <p class="loss-line"><b>${esc(stretches)} of the file could not be read</b>, ${esc(bytes(total))} in total. ${cost}
    Everything on either side of them was kept, so the recording plays through with those moments missing.</p>
    <ul class="damage">${rows}</ul>${more}`;
}

/* ---------------- wiring ---------------- */

$("pick-damaged").addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    const path = await browse("damaged");
    if (path) openFile(path);
  } catch (err) {
    fail(`The file picker did not open: ${err.message}`);
  }
});

// The whole panel is clickable as well, which is what people try first. The
// button inside it is the one that answers to the keyboard, so nothing here
// is reachable by mouse alone.
$("dropzone").addEventListener("click", () => $("pick-damaged").click());

$("pick-other").addEventListener("click", () => $("pick-damaged").click());

$("pick-ref").addEventListener("click", async () => {
  try {
    const path = await browse("reference");
    if (path) setReference(path);
  } catch (err) {
    fail(`The file picker did not open: ${err.message}`);
  }
});

$("ref-clear").addEventListener("click", () => {
  setReference(null);
  $("pick-ref").focus();
});

$("paste-damaged").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = cleanPath($("paste-damaged-input").value);
  if (path) openFile(path);
});

$("paste-reference").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = cleanPath($("paste-reference-input").value);
  if (path) setReference(path);
});

$("do-repair").addEventListener("click", startRepair);

$("reveal").addEventListener("click", async () => {
  try {
    await post("/api/reveal", { path: $("rs-path").textContent });
  } catch (err) {
    fail(`The folder could not be opened: ${err.message}`);
  }
});

$("again").addEventListener("click", reset);
$("start-over").addEventListener("click", reset);

function reset() {
  stopWork();
  state.path = null;
  state.diagnosis = null;
  state.reference = null;
  show("open");
  $("pick-damaged").focus();
}

/* ---------------- dropping a file ---------------- */

/* Two paths lead here. In the packaged app the native shell handles the drop
   and calls window.arganoDropped with a real location. In a browser the page
   sees the drop itself, where a dropped file carries a name and no location
   at all, so the honest answer is to say so and ask for the path. */
let dragging = 0;

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragging += 1;
  $("veil").hidden = false;
});

window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});

window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragging = Math.max(0, dragging - 1);
  if (!dragging) $("veil").hidden = true;
});

window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragging = 0;
  $("veil").hidden = true;

  const transfer = e.dataTransfer;
  const file = transfer.files && transfer.files[0];
  const direct = file && file.path;          // some shells put the real location here
  if (direct) { openFile(cleanPath(direct)); return; }

  const text = (transfer.getData("text/uri-list") || transfer.getData("text/plain") || "").trim();
  const fromText = cleanPath(text.split("\n")[0]);
  if (fromText.startsWith("/") || /^[A-Za-z]:\\/.test(fromText)) { openFile(fromText); return; }

  show("open");
  showPaste("damaged",
    file
      ? `A file dropped into a browser window arrives without its location, so ${file.name} cannot be opened this way. Paste the full path instead, or run argano as an app.`
      : "That drop carried no file location. Paste the full path instead.");
});

function hasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return Boolean(types && Array.prototype.indexOf.call(types, "Files") !== -1);
}

/* ---------------- start ---------------- */

show("open");
