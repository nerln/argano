/* argano, the interface, on a page.
 *
 * One ES module, no bundler, no dependencies beyond the repair itself, which
 * lives in ./lib and is imported below. Open the file, change a line, reload
 * the tab. That costs a few extra lines here and saves anyone who forks the
 * project from installing a toolchain to move a button.
 *
 * The shape of the app is a queue of one. A file is opened, looked at, and
 * either repaired or dropped. So there is no router and no store, just four
 * screens and the small amount of state that moves between them.
 *
 * The repair runs on this thread. It yields to the event loop as it goes, so
 * the clock keeps counting and the bars keep moving, and between those yields
 * the window stops answering. That is said out loud on the repair screen
 * rather than hidden behind a spinner that lies.
 */

import { diagnose, repair, RepairError } from './lib/repair.js';
import { LANGS, LOCALES, words, fromLib } from './i18n.js';

/* The inline script in the page is watching for this. Setting it says the
   module loaded, parsed and ran. */
window.arganoReady = true;

const $ = (id) => document.getElementById(id);

/* The page says which language it is in, and every sentence below comes from
   that language in i18n.js. A sentence the repair wrote in English is said
   again in this language when i18n.js knows it, and otherwise replaced by the
   fallback given, so a half translated screen never mixes two languages. */
const LANG = LANGS.includes((document.documentElement.lang || '').slice(0, 2))
  ? document.documentElement.lang.slice(0, 2)
  : 'en';
const W = words(LANG);
const LOCALE = LOCALES[LANG];
const say = (text, fallback = text) => fromLib(LANG, text) ?? fallback;

/* What the page counts, and nothing else: that it was opened, and then the
   steps of a repair (a file opened, a second video needed, the repair finished
   or stopped) and the answer to "did this save your video". Each is a single
   request to GoatCounter. No cookie, no identifier, and never a byte or a name
   from the video. A copy opened from disk, on localhost or in a fork served
   from anywhere else counts nothing.

   A step is filed under where the visit came from, the `ref` in the link or
   else the site that sent it, so the totals say how many repairs a channel
   brought and not only how many visits. */
const COUNTER = 'https://nerln.goatcounter.com/count';

const SOURCE = (() => {
  const tag = new URLSearchParams(location.search).get('ref') || '';
  if (tag) return tag.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'other';
  try {
    const host = new URL(document.referrer).hostname.replace(/^www\./, '');
    return host && host !== location.hostname ? host : 'direct';
  } catch { return 'direct'; }
})();

function tally(path, title, event = false) {
  if (location.origin !== 'https://nerln.github.io') return;
  const q = new URLSearchParams({ p: path, t: title, e: String(event) });
  if (!event) {
    q.set('r', document.referrer);
    q.set('q', location.search);
  }
  q.set('rnd', Math.random().toString(36).slice(2));
  fetch(`${COUNTER}?${q}`, { mode: 'no-cors', credentials: 'omit', keepalive: true })
    .catch(() => {});
}

const step = (name, title) => tally(`/argano/e/${name}/${SOURCE}`, `${title} (${SOURCE})`, true);

tally(location.pathname, document.title);

const state = {
  file: null,          // the damaged video, a File from a picker or a drop
  diagnosis: null,     // what diagnose() said about it
  reference: null,     // the working file its codec settings are read from
  running: false,      // a repair is on this thread right now
  clock: null,         // interval handle for the elapsed counter
  startedAt: 0,
  url: null,           // object URL behind the save link, revoked when it goes
};

/* The stages the repair reports, in the order they happen, with the words a
   person would use for them. The weights are how much of the wall clock each
   stage tends to take on a long file: they turn six separate fractions into
   one number that keeps moving forwards. They are an estimate and the screen
   says so, since the scan is the only stage whose length is known in advance. */
const STAGES = [
  { id: 'inspect', label: W.stInspect, weight: 3 },
  { id: 'scan', label: W.stScan, weight: 40 },
  { id: 'audio', label: W.stAudio, weight: 15 },
  { id: 'timeline', label: W.stTimeline, weight: 4 },
  { id: 'write', label: W.stWrite, weight: 26 },
  { id: 'verify', label: W.stVerify, weight: 12 },
];
const TOTAL_WEIGHT = STAGES.reduce((sum, s) => sum + s.weight, 0);

/* ---------------- formatting ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const count = (n) => Number(n || 0).toLocaleString(LOCALE);
const decimals = (n, places) => n.toLocaleString(LOCALE, {
  minimumFractionDigits: places, maximumFractionDigits: places,
});

/* Decimal units, the ones a file manager shows, so the numbers here agree with
   the numbers in Finder. Gigabytes get two decimals: a file of 1.28 GB with
   1.26 GB of media inside it would otherwise read as 1.3 GB twice over, and
   the whole point of that line is the difference between the two. */
function bytes(n) {
  const value = Number(n || 0);
  if (value < 1000) return `${value} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let scaled = value / 1000;
  let i = 0;
  while (scaled >= 1000 && i < units.length - 1) { scaled /= 1000; i += 1; }
  const places = scaled >= 10 ? 0 : i >= 2 ? 2 : 1;
  return `${decimals(scaled, places)} ${units[i]}`;
}

/* Durations read as 15m 36s, 1h 04m 12s, 42s. Padding the middle unit keeps
   the numbers from jumping about while the elapsed clock counts. */
function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const sentence = (s) => {
  const text = String(s || '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};

const percent = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

function share(part, whole) {
  const p = percent(part, whole);
  if (p > 0 && p < 0.1) return W.under;
  return (p / 100).toLocaleString(LOCALE, {
    style: 'percent', maximumFractionDigits: p >= 10 ? 0 : 1, minimumFractionDigits: p >= 10 ? 0 : 1,
  });
}

/* Track descriptions arrive as `vide:avc1`. The four letter codes are how the
   file format writes them down, and nobody outside this project reads them. */
const HANDLERS = W.handlers;
const CODECS = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC',
  mp4a: 'AAC', sowt: 'PCM', twos: 'PCM', lpcm: 'PCM', 'raw ': 'PCM', in24: 'PCM', fl32: 'PCM',
};

function trackWords(track) {
  const [handler, codec] = String(track || '').split(':');
  const kind = HANDLERS[handler] || handler || W.track;
  const name = CODECS[codec] || codec;
  return name ? `${kind} (${name})` : kind;
}

/* Box names, in the words used on the rest of the screen. */
const BOX_ROLE = {
  mdat: { role: 'media', words: W.boxWords.mdat },
  moov: { role: 'index', words: W.boxWords.moov },
  ftyp: { role: 'other', words: W.boxWords.ftyp },
  free: { role: 'other', words: W.boxWords.free },
  skip: { role: 'other', words: W.boxWords.skip },
  wide: { role: 'other', words: W.boxWords.wide },
  moof: { role: 'other', words: W.boxWords.moof },
  mfra: { role: 'other', words: W.boxWords.mfra },
};
const roleOf = (name) => (BOX_ROLE[name] ? BOX_ROLE[name].role : 'other');

/* ---------------- screens ---------------- */

const SCREENS = ['open', 'diagnosis', 'repair', 'result'];

/* Swapping screens moves focus to the new one rather than to its main button.
   Landing on the button would scroll the page past the diagnosis to reach it,
   and a screen reader would start halfway down a page nobody has read yet. A
   section with tabindex="-1" puts the caret at the top of what just arrived. */
function show(name) {
  for (const id of SCREENS) $(`screen-${id}`).hidden = id !== name;
  $('start-over').hidden = name === 'open';
  $('top-file').hidden = !state.file || name === 'open';
  if (state.file) $('top-file').textContent = state.file.name;
  if (name !== 'result') dropSaveLink();
  if (name === 'result') {
    $('rs-ask').hidden = false;
    $('rs-thanks').hidden = true;
  }
  clearAlert();
  window.scrollTo({ top: 0, behavior: 'auto' });
  $(`screen-${name}`).focus({ preventScroll: true });
}

function fail(message) {
  $('alert-text').textContent = message;
  $('alert').hidden = false;
}

function clearAlert() {
  $('alert').hidden = true;
  $('alert-text').textContent = '';
}

/* A message a person can read. RepairError already carries one, written for
   this moment, so it is shown as it stands. Anything else is a fault rather
   than a diagnosis, and saying which is which is more honest than dressing
   both up the same way. */
function reason(err) {
  if (err instanceof RepairError) {
    // A file with nothing to repair is refused with the diagnosis itself, so
    // it is said the way the diagnosis screen says it.
    if (state.diagnosis && err.message === state.diagnosis.detail) return detailFor(state.diagnosis);
    return say(err.message);
  }
  const detail = err && err.message ? err.message : String(err);
  return W.stopped(detail);
}

/* Let the browser paint before handing the thread to a stage that will hold
   it. Two frames, because one only guarantees the style has been recalculated.
   A tab in the background is given no frames at all, so a timer runs alongside
   and lets the work start anyway: waiting on a frame that never comes would
   leave a repair stopped at nought per cent until the person looked back. */
function painted() {
  return new Promise((resolve) => {
    let settled = false;
    const go = () => { if (!settled) { settled = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 150);
  });
}

/* ---------------- opening a file ---------------- */

async function openFile(file) {
  if (state.running) {
    fail(W.busy);
    return;
  }
  if (!file || !file.size) {
    fail(W.emptyFile);
    return;
  }

  const button = $('pick-damaged');
  const wasLabelled = button.textContent;
  button.disabled = true;
  button.textContent = W.readingFile;
  clearAlert();
  await painted();
  try {
    const diagnosis = await diagnose(file);
    state.file = file;
    state.diagnosis = diagnosis;
    state.reference = null;
    renderDiagnosis(diagnosis);
    show('diagnosis');
    step('file-opened', 'File opened');
    if (diagnosis.needsReference) step('reference-needed', 'Second video needed');
  } catch (err) {
    fail(W.cannotRead(err && err.message ? say(err.message) : String(err)));
  } finally {
    button.disabled = false;
    button.textContent = wasLabelled;
  }
}

/* ---------------- 2. diagnosis ---------------- */

function renderDiagnosis(dx) {
  const size = Number(dx.size || 0);
  const media = Number(dx.mediaSize || 0);

  $('dx-verdict').textContent = W.verdicts[dx.verdict] || sentence(dx.verdict) || W.somethingWrong;
  $('dx-detail').textContent = detailFor(dx);

  const tracks = Array.isArray(dx.tracks) ? dx.tracks : [];
  const facts = [
    [W.fFile, esc(dx.name || state.file.name)],
    [W.fSize, `${esc(bytes(size))} <span class="fine">${esc(W.inBytes(count(size)))}</span>`],
    [W.fMedia, `${esc(bytes(media))} <span class="fine">${esc(W.ofTheFile(share(media, size)))}</span>`],
    [W.fTracks, tracks.length
      ? esc(tracks.map(trackWords).join(', '))
      : `<span class="fine">${esc(W.noTracks)}</span>`],
  ];
  $('dx-facts').innerHTML = facts
    .map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`)
    .join('');

  renderStructure(dx, size, media);
  renderReference(dx);
  updateRepairHint();
}

/* The repair explains its verdict in English. In English that sentence is
   shown as it is; in another language the same sentence is written again from
   the same numbers. */
function detailFor(dx) {
  const write = W.details[dx.verdict];
  if (LANG === 'en' || !write) return dx.detail || '';
  const media = Number(dx.mediaSize || 0);
  const size = Number(dx.size || 0);
  return write(bytes(media), size ? Math.round((media / size) * 100) : 0);
}

/* The bar is drawn strictly to scale: each box sits at its real offset and is
   as wide as it really is. That is the point of it. Anything the boxes do not
   cover stays as the empty track behind them, and a missing index has no
   width at all, so it is stated in the legend rather than given an invented
   block that would make the picture a lie. */
function renderStructure(dx, size, media) {
  const boxes = Array.isArray(dx.topLevel) ? dx.topLevel : [];

  $('dx-bar').innerHTML = boxes.map(([name, offset, length]) => {
    const left = percent(Number(offset || 0), size);
    const width = Math.max(percent(Number(length || 0), size), 0.15);
    return `<span class="seg is-${roleOf(name)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span>`;
  }).join('');

  const hasIndex = boxes.some(([name]) => name === 'moov');
  // Three states, and the middle one is the reassuring one. A file with no
  // media at all must not be told that all of its frames are still there.
  let tail;
  if (!media) {
    tail = W.tailNoMedia;
  } else if (!dx.needsReference) {
    tail = W.tailReadable;
  } else {
    tail = W.tailMissing;
  }
  $('dx-read').innerHTML = `<b>${esc(W.mediaShare(share(media, size)))}</b> ${esc(tail)}`;

  const kinds = [];
  const seen = new Set();
  for (const [name] of boxes) {
    if (seen.has(name)) continue;
    seen.add(name);
    const known = BOX_ROLE[name];
    kinds.push(`<li><span class="swatch is-${roleOf(name)}"></span><b>${esc(name)}</b> ${esc(known ? known.words : W.boxOther)}</li>`);
  }
  if (!hasIndex) {
    kinds.push(`<li><span class="swatch is-gone"></span><b>moov</b> ${esc(W.indexNever)}</li>`);
  }
  $('dx-legend').innerHTML = kinds.join('');

  // A file whose bytes parsed as nothing at all has no rows to show, and a
  // table of headings over nothing reads as a table that failed to load.
  $('dx-table').hidden = boxes.length === 0;
  $('dx-boxes').innerHTML = boxes.map(([name, offset, length]) => `
    <tr class="${roleOf(name) === 'media' ? 'is-media' : ''}">
      <td>${esc(name)}</td>
      <td>${esc(bytes(offset))}</td>
      <td>${esc(bytes(length))}</td>
      <td>${esc(share(Number(length || 0), size))}</td>
    </tr>`).join('');
}

function renderReference(dx) {
  const needed = Boolean(dx.needsReference);
  // With no media in the file there is no repair to prepare for, and the card
  // would otherwise say the index can be read, which is not true of a file
  // that parsed as nothing.
  $('ref-card').hidden = !dx.repairable;
  $('ref-card').classList.toggle('is-needed', needed);
  $('ref-kicker').textContent = needed ? W.refNeededKicker : W.refOptionalKicker;
  $('ref-title').textContent = needed ? W.refNeededTitle : W.refOptionalTitle;
  $('ref-why').textContent = needed ? W.refNeededWhy : W.refOptionalWhy;
  $('ref-good').innerHTML = needed ? W.refGood.map((line) => `<li>${line}</li>`).join('') : '';

  setReference(null);
}

function setReference(file) {
  state.reference = file;
  $('ref-chosen').hidden = !file;
  $('ref-drop-hint').hidden = Boolean(file);
  if (file) {
    $('ref-name').textContent = file.name;
    $('ref-name').title = file.name;
    $('pick-ref').textContent = W.chooseDifferent;
  } else {
    $('pick-ref').textContent = W.chooseRef;
  }
  updateRepairHint();
}

function updateRepairHint() {
  const needed = Boolean(state.diagnosis && state.diagnosis.needsReference);
  const hint = $('repair-hint');
  if (state.diagnosis && !state.diagnosis.repairable) {
    hint.textContent = W.hintNoMedia;
    hint.classList.add('is-warning');
  } else if (needed && !state.reference) {
    hint.textContent = W.hintNeedRef;
    hint.classList.add('is-warning');
  } else {
    hint.textContent = W.hintReady;
    hint.classList.remove('is-warning');
  }
}

/* ---------------- 3. the repair ---------------- */

async function startRepair() {
  const needed = Boolean(state.diagnosis && state.diagnosis.needsReference);
  // The button stays live in this case rather than going grey. A dead button
  // with no explanation is the worst version of this: the person is told no
  // and not told why. Sending them to the picker, with the reason spoken, is
  // the same protection and it moves them forwards.
  if (needed && !state.reference) {
    fail(W.needRefFirst);
    $('pick-ref').focus();
    return;
  }

  state.running = true;
  $('do-repair').disabled = true;
  beginProgress();
  show('repair');
  // The first stage takes the thread as soon as it is called, so the screen
  // that reports it has to be on the glass before that happens.
  await painted();

  try {
    const result = await repair(state.file, {
      reference: state.reference,
      diagnosis: state.diagnosis,
      onProgress: renderProgress,
    });
    stopClock();
    renderResult(result);
    show('result');
    step('repaired', 'Repaired');
  } catch (err) {
    stopClock();
    show('diagnosis');
    fail(reason(err));
    step('stopped', 'Repair stopped');
  } finally {
    state.running = false;
    $('do-repair').disabled = false;
  }
}

function beginProgress() {
  $('rp-title').textContent = state.file.name;
  $('rp-pct').textContent = '0%';
  $('rp-bar').style.width = '0%';
  $('rp-track').setAttribute('aria-valuenow', '0');
  $('rp-note').textContent = W.starting;
  for (const item of $('rp-stages').children) {
    item.classList.remove('is-done', 'is-active');
    item.removeAttribute('aria-current');
    item.querySelector('.stage-bar > i').style.width = '0%';
  }
  state.startedAt = Date.now();
  tickClock();
  state.clock = setInterval(tickClock, 1000);
}

function tickClock() {
  const seconds = (Date.now() - state.startedAt) / 1000;
  $('rp-elapsed').textContent = W.soFar(duration(seconds));
}

function stopClock() {
  clearInterval(state.clock);
  state.clock = null;
}

/* Called by the repair itself, on this thread, between the pieces of work it
   does. Everything here is a handful of writes to the DOM: anything heavier
   would be paid for once per report, and the scan reports often. */
function renderProgress(stage, fraction, note) {
  const finishing = stage === 'done';
  const current = finishing ? STAGES.length : STAGES.findIndex((s) => s.id === stage);
  const part = Math.min(Math.max(Number(fraction) || 0, 0), 1);

  let passed = 0;
  $('rp-stages').querySelectorAll('li').forEach((item, i) => {
    // Anything before the stage now running has been passed, whether it
    // reported or not. Some files have no audio, and that stage never speaks.
    const done = current >= 0 && i < current;
    const active = i === current;
    item.classList.toggle('is-done', done);
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    item.querySelector('.stage-bar > i').style.width = active ? `${(part * 100).toFixed(1)}%` : '0%';
    if (done) passed += STAGES[i].weight;
  });

  const here = current >= 0 && current < STAGES.length ? STAGES[current].weight * part : 0;
  const overall = Math.min(((passed + here) / TOTAL_WEIGHT) * 100, 99);
  $('rp-pct').textContent = `${Math.floor(overall)}%`;
  $('rp-bar').style.width = `${overall.toFixed(1)}%`;
  $('rp-track').setAttribute('aria-valuenow', String(Math.floor(overall)));

  const label = current >= 0 && current < STAGES.length ? STAGES[current].label : '';
  const line = note ? say(note, label) : label;
  if (line && $('rp-note').textContent !== sentence(line)) $('rp-note').textContent = sentence(line);
}

/* ---------------- 4. the result ---------------- */

function timingWords(model) {
  const value = String(model || '').trim();
  if (!value) return W.timingDefault;
  if (value === 'audio-anchored') return W.timingAudio;
  if (value.startsWith('fixed')) return W.timingFixed(esc(value.replace(/^fixed\s*/, '')));
  if (value === 'no video') return W.timingNoVideo;
  return esc(value);
}

const DAMAGE_WORDS = W.damageWords;

/* The repaired file is a Blob living in this tab, so the link that saves it
   holds the only handle to it. The old one is let go whenever a new one is
   made or the result screen is left, since a Blob URL keeps its file alive
   for as long as the page does. */
function setSaveLink(result) {
  dropSaveLink();
  state.url = URL.createObjectURL(result.blob);
  const link = $('rs-download');
  link.href = state.url;
  link.download = result.name;
  $('rs-filename').textContent = result.name;
  $('rs-size').textContent = bytes(result.blob.size);
}

function dropSaveLink() {
  if (!state.url) return;
  URL.revokeObjectURL(state.url);
  state.url = null;
  $('rs-download').removeAttribute('href');
}

function renderResult(result) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const errors = findings.filter((f) => f && f.level === 'error');
  const warnings = findings.filter((f) => f && f.level !== 'error');
  const damage = Array.isArray(result.damage) ? result.damage : [];
  const lost = Number(result.lostSeconds || 0);

  $('rs-kicker').textContent = errors.length ? W.kickerProblems : W.kickerDone;
  $('rs-kicker').classList.toggle('is-bad', errors.length > 0);
  $('rs-title').textContent = errors.length
    ? W.titleCheck
    : damage.length
      ? W.titleLoss
      : W.titleDone;
  $('rs-sub').textContent = errors.length ? W.subCheck : W.subDone;

  const width = Number(result.width || 0);
  const height = Number(result.height || 0);
  const stats = [
    [duration(result.duration), W.statVideo],
    [count(result.videoFrames), W.statVideoFrames],
    [count(result.audioFrames), W.statAudioFrames],
    [width && height ? `${width}×${height}` : W.unknown, W.statFrameSize],
  ];
  $('rs-stats').innerHTML = stats
    .map(([value, name]) => `<li><span class="stat-value">${esc(value)}</span><span class="stat-name">${esc(name)}</span></li>`)
    .join('');

  setSaveLink(result);

  $('rs-findings').innerHTML = errors
    .map((f) => finding('error', say(f.message)))
    .concat(warnings.map((f) => finding('warning', say(f.message))))
    .join('');

  renderLoss(damage, lost);

  $('rs-how').innerHTML = [
    [W.howTiming, timingWords(result.timingModel)],
    [W.howSettings, esc(result.profileSource ? say(result.profileSource) : W.fileItself)],
    [W.howQuality, W.howQualityValue],
  ].map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('');
}

function finding(level, message) {
  const tag = level === 'error' ? W.tagError : W.tagWarning;
  return `<div class="finding is-${level}"${level === 'error' ? ' role="alert"' : ''}>
    <span class="finding-tag">${tag}</span><span>${esc(sentence(message))}</span>
  </div>`;
}

/* Being specific about loss is the point of this block. A repair that quietly
   swallowed nine seconds of a wedding and reported success is worse than one
   that says which nine seconds went. */
function renderLoss(damage, lost) {
  const box = $('rs-loss');
  if (!damage.length) {
    box.innerHTML = `<h2 class="sub">${esc(W.lossTitle)}</h2>
      <p class="loss-line">${W.lossNone}</p>`;
    return;
  }

  const total = damage.reduce((sum, d) => sum + Number(d.length || 0), 0);
  const stretches = damage.length === 1 ? W.oneStretch : W.stretches(count(damage.length));
  const cost = lost >= 1
    ? W.lossAbout(esc(duration(lost)))
    : lost > 0
      ? W.lossUnderSecond
      : '';

  const rows = damage.slice(0, 12).map((d) => `
    <li>
      <span class="at">${esc(W.lossAt(bytes(d.offset)))}</span>
      <span class="len">${esc(bytes(d.length))}</span>
      <span class="what">${esc(DAMAGE_WORDS[d.kind] || d.kind || W.unreadable)}</span>
    </li>`).join('');
  const more = damage.length > 12
    ? `<p class="fine">${esc(W.lossMore(count(damage.length - 12)))}</p>`
    : '';

  box.innerHTML = `<h2 class="sub">${esc(W.lossTitle)}</h2>
    <p class="loss-line">${W.lossLine(esc(stretches), esc(bytes(total)), cost)}</p>
    <ul class="damage">${rows}</ul>${more}`;
}

/* ---------------- wiring ---------------- */

/* A picker can only be opened by an input, and an input styled to look like
   the rest of the page is a fight nobody wins. So the buttons press a hidden
   input, and the input is what the browser talks to. */
function pick(input) {
  input.value = '';
  input.click();
}

$('pick-damaged').addEventListener('click', (e) => {
  e.stopPropagation();
  pick($('file-damaged'));
});

// The whole panel is clickable as well, which is what people try first. The
// button inside it is the one that answers to the keyboard, so nothing here
// is reachable by mouse alone.
$('dropzone').addEventListener('click', () => pick($('file-damaged')));

$('pick-other').addEventListener('click', () => pick($('file-damaged')));
$('pick-ref').addEventListener('click', () => pick($('file-reference')));

$('file-damaged').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) openFile(file);
});

$('file-reference').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) setReference(file);
});

$('ref-clear').addEventListener('click', () => {
  setReference(null);
  $('pick-ref').focus();
});

$('do-repair').addEventListener('click', startRepair);
$('again').addEventListener('click', reset);

// The answer says whether the copy really plays, which the repair cannot see
// for itself. Few people answer, so it is read beside the steps above and
// never on its own.
for (const [id, answer] of [['ask-yes', 'said-yes'], ['ask-no', 'said-no']]) {
  $(id).addEventListener('click', () => {
    step(answer, answer === 'said-yes' ? 'Said it plays' : 'Said it does not play');
    $('rs-ask').hidden = true;
    $('rs-thanks').hidden = false;
  });
}
$('start-over').addEventListener('click', reset);

// Saving is the browser's job from here. The link is left in place, because
// somebody who saved it to the wrong folder will want to press it twice.
$('rs-download').addEventListener('click', (e) => {
  if (!state.url) {
    e.preventDefault();
    fail(W.copyGone);
  }
});

function reset() {
  if (state.running) {
    fail(W.busy);
    return;
  }
  stopClock();
  state.file = null;
  state.diagnosis = null;
  state.reference = null;
  show('open');
  $('pick-damaged').focus();
}

/* A Blob URL keeps its file alive for as long as the page lives, so it is let
   go on the way out as well. */
window.addEventListener('pagehide', dropSaveLink);

/* ---------------- dropping a file ---------------- */

/* The main route in. A drop carries real File objects, so there is nothing to
   ask for and nothing to paste. Dropping anywhere opens a damaged file, apart
   from the reference card, which takes the second video instead and keeps the
   event to itself. */
let dragging = 0;

function hasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return Boolean(types && Array.prototype.indexOf.call(types, 'Files') !== -1);
}

function hideVeil() {
  dragging = 0;
  $('veil').hidden = true;
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragging += 1;
  $('veil').hidden = false;
});

window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});

window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragging = Math.max(0, dragging - 1);
  if (!dragging) $('veil').hidden = true;
});

window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  hideVeil();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) openFile(file);
});

/* The reference card takes its own drop. It is only on screen when a second
   video is the thing being asked for, so a file landing on it means that one
   and not a new damaged file. */
const refCard = $('ref-card');

refCard.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  refCard.classList.add('is-over');
});

refCard.addEventListener('dragleave', () => refCard.classList.remove('is-over'));

refCard.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  refCard.classList.remove('is-over');
  hideVeil();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setReference(file);
});

/* ---------------- start ---------------- */

/* Reading a File as bytes is the one thing this page cannot do without. Every
   browser that loads modules has had it for years, so this is the belt to the
   module check's braces, and it says which thing is missing. */
if (typeof File === 'undefined' || typeof File.prototype.arrayBuffer !== 'function'
    || typeof URL.createObjectURL !== 'function') {
  window.arganoStopped(W.noBytes);
} else {
  setReference(null);
  show('open');
}

/* ---------------- theme and language ---------------- */

/* The head of the page has already chosen light or dark before the first
   paint. The button flips it and remembers the choice in this browser only;
   with no choice made, the page keeps following the system as it changes. */
const THEME_KEY = 'argano-theme';

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

$('theme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private window: it lasts this visit */ }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (savedTheme()) return;
  document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
});

/* Someone whose browser asks for Italian or Spanish and lands on another
   language is offered theirs, once, as a link. Nobody is moved without
   asking, and someone who arrived here from another argano page has already
   chosen. */
(function offerLanguage() {
  if (document.referrer.startsWith(`${location.origin}/argano/`)) return;
  const wanted = (navigator.languages || [navigator.language || ''])
    .map((l) => String(l).slice(0, 2).toLowerCase())
    .find((l) => LANGS.includes(l));
  if (!wanted || wanted === LANG) return;
  const up = LANG === 'en' ? '' : '../';
  const link = $('lang-suggest');
  link.href = wanted === 'en' ? (up || './') : `${up}${wanted}/`;
  link.lang = wanted;
  link.textContent = words(wanted).readIn;
  link.hidden = false;
})();
