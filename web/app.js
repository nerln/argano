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

/* The inline script in the page is watching for this. Setting it says the
   module loaded, parsed and ran. */
window.arganoReady = true;

const $ = (id) => document.getElementById(id);

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
  { id: 'inspect', label: 'Read the file', weight: 3 },
  { id: 'scan', label: 'Find the frames', weight: 40 },
  { id: 'audio', label: 'Split the sound into frames', weight: 15 },
  { id: 'timeline', label: 'Put the frames back on a clock', weight: 4 },
  { id: 'write', label: 'Write the repaired copy', weight: 26 },
  { id: 'verify', label: 'Check the result', weight: 12 },
];
const TOTAL_WEIGHT = STAGES.reduce((sum, s) => sum + s.weight, 0);

/* ---------------- formatting ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const count = (n) => Number(n || 0).toLocaleString('en-GB');

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
  return `${scaled.toFixed(places)} ${units[i]}`;
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
  if (p > 0 && p < 0.1) return 'under 0.1%';
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

/* Track descriptions arrive as `vide:avc1`. The four letter codes are how the
   file format writes them down, and nobody outside this project reads them. */
const HANDLERS = { vide: 'picture', soun: 'sound', sbtl: 'subtitles', text: 'text', meta: 'data' };
const CODECS = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC',
  mp4a: 'AAC', sowt: 'PCM', twos: 'PCM', lpcm: 'PCM', 'raw ': 'PCM', in24: 'PCM', fl32: 'PCM',
};

function trackWords(track) {
  const [handler, codec] = String(track || '').split(':');
  const kind = HANDLERS[handler] || handler || 'track';
  const name = CODECS[codec] || codec;
  return name ? `${kind} (${name})` : kind;
}

/* Box names, in the words used on the rest of the screen. */
const BOX_ROLE = {
  mdat: { role: 'media', words: 'the audio and video themselves' },
  moov: { role: 'index', words: 'the index that says where every frame starts' },
  ftyp: { role: 'other', words: 'a few bytes naming the file format' },
  free: { role: 'other', words: 'padding left by the recorder' },
  skip: { role: 'other', words: 'padding left by the recorder' },
  wide: { role: 'other', words: 'padding left by the recorder' },
  moof: { role: 'other', words: 'a fragment header' },
  mfra: { role: 'other', words: 'a fragment index' },
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
  if (err instanceof RepairError) return err.message;
  const detail = err && err.message ? err.message : String(err);
  return `The repair stopped part way through. What it reported was: ${detail}`;
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
    fail('A repair is running on this tab. Wait for it to finish, then open the next file.');
    return;
  }
  if (!file || !file.size) {
    fail('That file came through empty. If it is on a phone or a network folder, copy it to this computer first.');
    return;
  }

  const button = $('pick-damaged');
  const wasLabelled = button.textContent;
  button.disabled = true;
  button.textContent = 'Reading the file…';
  clearAlert();
  await painted();
  try {
    const diagnosis = await diagnose(file);
    state.file = file;
    state.diagnosis = diagnosis;
    state.reference = null;
    renderDiagnosis(diagnosis);
    show('diagnosis');
  } catch (err) {
    fail(`That file could not be read: ${err && err.message ? err.message : String(err)}`);
  } finally {
    button.disabled = false;
    button.textContent = wasLabelled;
  }
}

/* ---------------- 2. diagnosis ---------------- */

function renderDiagnosis(dx) {
  const size = Number(dx.size || 0);
  const media = Number(dx.mediaSize || 0);

  $('dx-verdict').textContent = sentence(dx.verdict) || 'Something is wrong with this file';
  $('dx-detail').textContent = dx.detail || '';

  const tracks = Array.isArray(dx.tracks) ? dx.tracks : [];
  const facts = [
    ['File', esc(dx.name || state.file.name)],
    ['Size', `${esc(bytes(size))} <span class="fine">(${esc(count(size))} bytes)</span>`],
    ['Media', `${esc(bytes(media))} <span class="fine">(${esc(share(media, size))} of the file)</span>`],
    ['Tracks', tracks.length
      ? esc(tracks.map(trackWords).join(', '))
      : '<span class="fine">none named, because the part that names them is gone</span>'],
  ];
  $('dx-facts').innerHTML = facts
    .map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`)
    .join('');

  renderStructure(dx, size, media);
  renderReference(dx);
  updateRepairHint();
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
    tail = 'There is no block of media in this file, so there is nothing here to index.';
  } else if (!dx.needsReference) {
    tail = 'The index beside it can still be read, so the file can describe itself.';
  } else {
    tail = 'Every frame is still in there. What is missing is the index that says where each one starts, which is why nothing will play it.';
  }
  $('dx-read').innerHTML = `<b>${esc(share(media, size))} of this file is media.</b> ${esc(tail)}`;

  const kinds = [];
  const seen = new Set();
  for (const [name] of boxes) {
    if (seen.has(name)) continue;
    seen.add(name);
    const known = BOX_ROLE[name];
    kinds.push(`<li><span class="swatch is-${roleOf(name)}"></span><b>${esc(name)}</b> ${esc(known ? known.words : "part of the file's structure")}</li>`);
  }
  if (!hasIndex) {
    kinds.push('<li><span class="swatch is-gone"></span><b>moov</b> the index, never written</li>');
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
  $('ref-kicker').textContent = needed ? 'Needed for this file' : 'Optional for this file';
  $('ref-title').textContent = needed
    ? 'Pick a working video to read the settings from'
    : 'This file can describe itself';

  $('ref-why').textContent = needed
    ? 'A recording that was never finalised has lost the part that says how the picture was '
      + 'encoded, and those settings cannot be guessed from the bytes alone. argano reads them '
      + 'from a video that still plays, then applies them to yours. The reference is only read, '
      + 'and it is not copied into the result.'
    : 'The index in this file can still be read, so the settings are taken from the file itself. '
      + 'Adding a reference is optional. It is worth doing if the repaired copy comes out with '
      + 'the wrong colours or the wrong size.';

  $('ref-good').innerHTML = needed ? [
    '<b>The same camera or app</b> that made the damaged file.',
    '<b>The same recording setting</b>: the same resolution and frame rate, from the same mode or preset.',
    '<b>Any length.</b> Three seconds is enough, and a short clip is read faster.',
    '<b>Straight off the device.</b> A clip that other software has already exported describes that software, not your camera.',
  ].map((line) => `<li>${line}</li>`).join('') : '';

  setReference(null);
}

function setReference(file) {
  state.reference = file;
  $('ref-chosen').hidden = !file;
  $('ref-drop-hint').hidden = Boolean(file);
  if (file) {
    $('ref-name').textContent = file.name;
    $('ref-name').title = file.name;
    $('pick-ref').textContent = 'Choose a different one';
  } else {
    $('pick-ref').textContent = 'Choose reference video';
  }
  updateRepairHint();
}

function updateRepairHint() {
  const needed = Boolean(state.diagnosis && state.diagnosis.needsReference);
  const hint = $('repair-hint');
  if (state.diagnosis && !state.diagnosis.repairable) {
    hint.textContent = 'There is no media in this file to rebuild an index around, so there is '
      + 'nothing here for argano to work on.';
    hint.classList.add('is-warning');
  } else if (needed && !state.reference) {
    hint.textContent = 'A reference video is needed before this one can be repaired.';
    hint.classList.add('is-warning');
  } else {
    hint.textContent = 'Your file is only read. A repaired copy is built in this tab and offered to you '
      + 'to save when it is done. A long recording takes a few minutes.';
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
    fail('This file needs a reference video first: it has nothing left in it that says how the picture was encoded.');
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
  } catch (err) {
    stopClock();
    show('diagnosis');
    fail(reason(err));
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
  $('rp-note').textContent = 'Starting';
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
  $('rp-elapsed').textContent = `${duration(seconds)} so far`;
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

  const line = note || (current >= 0 && current < STAGES.length ? STAGES[current].label.toLowerCase() : '');
  if (line && $('rp-note').textContent !== sentence(line)) $('rp-note').textContent = sentence(line);
}

/* ---------------- 4. the result ---------------- */

function timingWords(model) {
  const value = String(model || '').trim();
  if (!value) return 'the order the frames were written in';
  if (value === 'audio-anchored') {
    return 'the audio track <em>(each picture placed by the sound recorded beside it, which is the truest clock a file like this has)</em>';
  }
  if (value.startsWith('fixed')) {
    return `an even rate, ${esc(value.replace(/^fixed\s*/, ''))} <em>(there was no audio to follow, so the frames were spread evenly)</em>`;
  }
  if (value === 'no video') return 'no video track was found';
  return esc(value);
}

const DAMAGE_WORDS = {
  'unreadable-audio': 'sound that could not be read',
  'unreadable-tail': 'an unreadable stretch at the end of the media',
  garbage: 'bytes that matched no frame',
};

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

  $('rs-kicker').textContent = errors.length ? 'Finished, with problems' : 'Finished';
  $('rs-kicker').classList.toggle('is-bad', errors.length > 0);
  $('rs-title').textContent = errors.length
    ? 'Repaired, and worth checking'
    : damage.length
      ? 'Repaired, with some loss'
      : 'Repaired';
  $('rs-sub').textContent = errors.length
    ? 'A new file was built. The checks found something that may stop it playing everywhere, so watch it through before you delete anything.'
    : 'A new file was built. Nothing was encoded again, so the picture and the sound are the ones you recorded.';

  const width = Number(result.width || 0);
  const height = Number(result.height || 0);
  const stats = [
    [duration(result.duration), 'of video'],
    [count(result.videoFrames), 'video frames'],
    [count(result.audioFrames), 'audio frames'],
    [width && height ? `${width}×${height}` : 'unknown', 'frame size'],
  ];
  $('rs-stats').innerHTML = stats
    .map(([value, name]) => `<li><span class="stat-value">${esc(value)}</span><span class="stat-name">${esc(name)}</span></li>`)
    .join('');

  setSaveLink(result);

  $('rs-findings').innerHTML = errors
    .map((f) => finding('error', f.message))
    .concat(warnings.map((f) => finding('warning', f.message)))
    .join('');

  renderLoss(damage, lost);

  $('rs-how').innerHTML = [
    ['Timing from', timingWords(result.timingModel)],
    ['Codec settings from', esc(result.profileSource || 'the file itself')],
    ['Quality', 'untouched. The media bytes in the new file are the media bytes from the old one.'],
  ].map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('');
}

function finding(level, message) {
  const tag = level === 'error' ? 'Error' : 'Warning';
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
    box.innerHTML = `<h2 class="sub">What was lost</h2>
      <p class="loss-line"><b>Nothing.</b> Every byte of the media was read, and all of it is in the new file.</p>`;
    return;
  }

  const total = damage.reduce((sum, d) => sum + Number(d.length || 0), 0);
  const stretches = damage.length === 1 ? 'one stretch' : `${count(damage.length)} stretches`;
  const cost = lost >= 1
    ? `That is about ${esc(duration(lost))} of the recording.`
    : lost > 0
      ? 'That is under a second of the recording.'
      : '';

  const rows = damage.slice(0, 12).map((d) => `
    <li>
      <span class="at">at ${esc(bytes(d.offset))}</span>
      <span class="len">${esc(bytes(d.length))}</span>
      <span class="what">${esc(DAMAGE_WORDS[d.kind] || d.kind || 'unreadable')}</span>
    </li>`).join('');
  const more = damage.length > 12
    ? `<p class="fine">${esc(count(damage.length - 12))} shorter stretches are not listed.</p>`
    : '';

  box.innerHTML = `<h2 class="sub">What was lost</h2>
    <p class="loss-line"><b>${esc(stretches)} of the file could not be read</b>, ${esc(bytes(total))} in total. ${cost}
    Everything on either side of them was kept, so the recording plays through with those moments missing.</p>
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
$('start-over').addEventListener('click', reset);

// Saving is the browser's job from here. The link is left in place, because
// somebody who saved it to the wrong folder will want to press it twice.
$('rs-download').addEventListener('click', (e) => {
  if (!state.url) {
    e.preventDefault();
    fail('That copy is no longer held in this tab. Repair the file again to get it back.');
  }
});

function reset() {
  if (state.running) {
    fail('A repair is running on this tab. Wait for it to finish, then open the next file.');
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
  window.arganoStopped('This browser cannot hand a chosen file to a page as bytes, which is '
    + 'the one thing the repair needs before it can start.');
} else {
  show('open');
}
