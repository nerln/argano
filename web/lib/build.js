/* Learning how a file is built, putting frames back on a clock, writing the index. */

import {
  IDENTITY_MATRIX, box, concat, findAll, findBox, fullBox, parseBoxes,
  readU16, readU32, readU64, runLengthEncode, table, u16, u32, u64,
} from './boxes.js';

/* --- what a working file can teach us ---------------------------------- */

/* The sample description, the handler boxes and the aperture box are copied
 * across as bytes rather than parsed and rebuilt. A rebuilt descriptor is a
 * chance to get a detail wrong for no gain, and copying keeps colour
 * information and vendor boxes instead of quietly dropping them. */
export function readProfile(data) {
  const boxes = parseBoxes(data, 0, data.length);
  const moov = boxes.find((b) => b.name === 'moov');
  if (!moov) throw new Error('this file has no index to learn from');

  const profile = {
    movieTimescale: 600, created: 0, modified: 0,
    matrix: IDENTITY_MATRIX, video: null, audio: null,
  };

  const mvhd = findBox(moov.children, 'mvhd');
  if (mvhd) {
    const p = data.subarray(mvhd.payload, mvhd.end);
    if (p[0] === 0 && p.length >= 20) {
      profile.created = readU32(p, 4);
      profile.modified = readU32(p, 8);
      profile.movieTimescale = readU32(p, 12);
    } else if (p.length >= 32) {
      profile.movieTimescale = readU32(p, 20);
    }
  }

  for (const trak of findAll(moov, 'trak')) {
    const track = readTrack(data, trak, profile.movieTimescale);
    if (!track) continue;
    if (track.handler === 'vide' && !profile.video) profile.video = track;
    else if (track.handler === 'soun' && !profile.audio) profile.audio = track;
  }
  if (!profile.video && !profile.audio) throw new Error('no tracks to learn from');
  return profile;
}

/* The biggest frame the reference holds. It becomes the ceiling on what counts
 * as a frame in the damaged file, and that ceiling is what stops four bytes of
 * noise being read as a length of nine megabytes. */
function largestSampleSize(data, stbl) {
  const stsz = findBox(stbl.children, 'stsz');
  if (!stsz) return 0;
  const p = data.subarray(stsz.payload, stsz.end);
  if (p.length < 12) return 0;
  const uniform = readU32(p, 4);
  const count = Math.min(readU32(p, 8), 20000);
  if (uniform) return uniform;
  let most = 0;
  for (let i = 0; i < count && 12 + i * 4 + 4 <= p.length; i++) {
    most = Math.max(most, readU32(p, 12 + i * 4));
  }
  return most;
}

function slice(data, node) {
  return node ? data.slice(node.offset, node.end) : null;
}

function readTrack(data, trak, movieTimescale) {
  const mdia = findBox(trak.children, 'mdia');
  if (!mdia) return null;
  const hdlr = findBox(mdia.children, 'hdlr');
  if (!hdlr) return null;
  const handler = String.fromCharCode(...data.subarray(hdlr.payload + 8, hdlr.payload + 12));
  if (handler !== 'vide' && handler !== 'soun') return null;

  let timescale = 600;
  let language = 0x55c4;
  const mdhd = findBox(mdia.children, 'mdhd');
  if (mdhd) {
    const p = data.subarray(mdhd.payload, mdhd.end);
    if (p[0] === 0 && p.length >= 22) {
      timescale = readU32(p, 12);
      language = readU16(p, 20);
    } else if (p.length >= 28) {
      timescale = readU32(p, 20);
    }
  }

  const stbl = findBox(mdia.children, 'minf/stbl');
  if (!stbl) return null;
  const stsd = findBox(stbl.children, 'stsd');
  if (!stsd) return null;
  const entry = firstSampleEntry(data.subarray(stsd.payload, stsd.end));
  if (!entry) return null;

  const track = {
    handler, timescale, language,
    fourcc: entry.fourcc,
    width: entry.width, height: entry.height,
    sampleRate: entry.sampleRate || timescale,
    channels: entry.channels,
    codecConfig: entry.config,
    stsd: slice(data, stsd),
    tapt: slice(data, findBox(trak.children, 'tapt')),
    mediaHeader: slice(data, findBox(mdia.children, 'minf/vmhd') || findBox(mdia.children, 'minf/smhd')),
    mediaHdlr: slice(data, hdlr),
    minfHdlr: slice(data, findBox(mdia.children, 'minf/hdlr')),
    dinf: slice(data, findBox(mdia.children, 'minf/dinf')),
    sgpd: slice(data, findBox(stbl.children, 'sgpd')),
    encoderDelay: 0,
    emptyEdit: 0,
    largestSample: largestSampleSize(data, stbl),
  };
  readEditList(data, trak, track);
  return track;
}

/* A visual sample entry is a fixed 86 byte block before its children: geometry
 * at 32, then resolutions, a 32 byte compressor name, the pixel depth and a
 * colour table index. An audio entry is 36 bytes, or 52 in the version
 * QuickTime writes, and the codec record sits behind that. */
function firstSampleEntry(payload) {
  if (payload.length < 16) return null;
  if (readU32(payload, 4) < 1) return null;
  const entry = payload.subarray(8);
  const size = readU32(entry, 0);
  const body = entry.subarray(0, size);
  const fourcc = String.fromCharCode(...body.subarray(4, 8));

  let width = 0, height = 0, sampleRate = 0, channels = 0;
  let config = new Uint8Array(0);

  if (body.length >= 86 && body[84] === 0xff && body[85] === 0xff) {
    width = readU16(body, 32);
    height = readU16(body, 34);
    config = findChild(body, 86, ['avcC', 'hvcC']);
  } else if (body.length >= 36) {
    channels = readU16(body, 24);
    sampleRate = readU32(body, 32) >>> 16;
    const version = readU16(body, 16);
    const start = 36 + (version === 1 ? 16 : 0) + (version === 2 ? 36 : 0);
    config = findChild(body, start, ['esds']);
    if (!config.length) {
      const wave = findChild(body, start, ['wave']);
      if (wave.length) config = findChild(wave, 0, ['esds']);
    }
  }
  return { fourcc, width, height, sampleRate, channels, config };
}

function findChild(body, start, wanted) {
  let pos = start;
  while (pos + 8 <= body.length) {
    const size = readU32(body, pos);
    const name = String.fromCharCode(...body.subarray(pos + 4, pos + 8));
    if (size < 8 || pos + size > body.length) break;
    if (wanted.includes(name)) return body.slice(pos + 8, pos + size);
    pos += size;
  }
  return new Uint8Array(0);
}

/* Compressed sound starts with priming samples that are decoded and thrown
 * away. A file says so with an edit list, and copying that intent keeps a
 * rebuilt file in sync instead of running the sound a little early. */
function readEditList(data, trak, track) {
  const elst = findBox(trak.children, 'edts/elst');
  if (!elst) return;
  const p = data.subarray(elst.payload, elst.end);
  if (p.length < 8) return;
  const version = p[0];
  const count = readU32(p, 4);
  let pos = 8;
  for (let i = 0; i < count; i++) {
    let duration, mediaTime;
    if (version === 1) {
      if (pos + 20 > p.length) break;
      duration = readU64(p, pos);
      mediaTime = readU64(p, pos + 8);
      if (mediaTime > 0x7fffffffffffffff) mediaTime = -1;
      pos += 20;
    } else {
      if (pos + 12 > p.length) break;
      duration = readU32(p, pos);
      mediaTime = readU32(p, pos + 4) | 0;
      pos += 12;
    }
    if (mediaTime < 0) track.emptyEdit = Math.max(track.emptyEdit, duration);
    else if (mediaTime > 0 && !track.encoderDelay) track.encoderDelay = mediaTime;
  }
}

/* --- putting the frames back on a clock -------------------------------- */

/* The count in a frame header is truncated: it counts up and rolls over, and
 * the top half is left for the decoder to track. Sorting the raw value sends
 * every frame after the first rollover to the start of the film. */
export function displayOrder(samples, maxPocLsb) {
  const n = samples.length;
  if (!n) return [];
  if (!maxPocLsb || samples.every((s) => s.poc === null || s.poc === undefined)) {
    return samples.map((_, i) => i);
  }
  const half = maxPocLsb / 2;
  const ranks = new Array(n).fill(0);
  let groupStart = 0;
  let nextRank = 0;
  let order = [];
  let prevLsb = 0;
  let prevMsb = 0;

  const close = () => {
    order.sort((a, b) => a[0] - b[0]);
    order.forEach(([, index], position) => { ranks[index] = nextRank + position; });
    nextRank += order.length;
    order = [];
  };

  for (let i = 0; i < n; i++) {
    const sample = samples[i];
    if (sample.sync && i > groupStart) {
      close();
      groupStart = i;
      prevLsb = 0;
      prevMsb = 0;
    }
    let full;
    const lsb = sample.poc;
    if (lsb === null || lsb === undefined) {
      full = prevMsb + prevLsb + 1;
    } else {
      let msb;
      if (sample.sync && i === groupStart) { msb = 0; prevLsb = 0; }
      else if (lsb < prevLsb && prevLsb - lsb >= half) msb = prevMsb + maxPocLsb;
      else if (lsb > prevLsb && lsb - prevLsb > half) msb = prevMsb - maxPocLsb;
      else msb = prevMsb;
      full = msb + lsb;
      if (sample.reference) { prevMsb = msb; prevLsb = lsb; }
    }
    order.push([full, i]);
  }
  close();
  return ranks;
}

/* Each run of video is given the stretch of time the sound written before the
 * next run accounts for, and the frames in it are spread across that. Nothing
 * here needs to know the frame rate, which is the point: phones and screen
 * recorders write a rate that moves with the scene, and a constant one laid
 * over fifteen minutes drifts far enough to be visible. */
export function audioAnchoredSlots(scan, samplesPerSpan) {
  if (!scan.video.length) return { slots: [], model: 'no video' };
  const spans = scan.audioSpans.map(([offset, length], i) => [offset, length, samplesPerSpan[i] || 0]);
  spans.sort((a, b) => a[0] - b[0]);

  const boundaries = [];
  let running = 0;
  for (const [offset, , samples] of spans) {
    boundaries.push([offset, running]);
    running += samples;
  }
  const totalAudio = running;

  const clockAt = (offset) => {
    let low = 0, high = boundaries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (boundaries[mid][0] < offset) low = mid + 1; else high = mid;
    }
    if (low === 0) return 0;
    return boundaries[low - 1][1] + spans[low - 1][2];
  };

  const firstOffset = new Map();
  const counts = new Map();
  for (const sample of scan.video) {
    if (!firstOffset.has(sample.chunk)) firstOffset.set(sample.chunk, sample.offset);
    counts.set(sample.chunk, (counts.get(sample.chunk) || 0) + 1);
  }
  const chunks = [...firstOffset.keys()].sort((a, b) => a - b);
  const starts = new Map(chunks.map((c) => [c, clockAt(firstOffset.get(c))]));

  const slots = [];
  let average = 0;
  chunks.forEach((chunk, position) => {
    const count = counts.get(chunk);
    const begin = starts.get(chunk);
    const finish = position + 1 < chunks.length
      ? starts.get(chunks[position + 1])
      : Math.max(totalAudio, begin + (average || 1) * count);
    let width = finish - begin;
    if (width <= 0) width = (average || 1) * count;
    for (let i = 0; i < count; i++) slots.push(begin + Math.floor((i * width) / count));
    average = Math.floor(width / count);
  });

  return { slots: strictlyIncreasing(slots), model: 'audio-anchored' };
}

export function fixedRateSlots(count, timescale, fps) {
  const step = timescale / fps;
  const slots = [];
  for (let i = 0; i < count; i++) slots.push(Math.round(i * step));
  return { slots, model: `fixed ${fps} fps` };
}

function strictlyIncreasing(values) {
  let last = -1;
  return values.map((value) => {
    const next = value <= last ? last + 1 : value;
    last = next;
    return next;
  });
}

/* Presentation offsets are kept at or above zero and the track starts a little
 * late to pay for it, which is expressed as an edit. Letting the first frames
 * carry negative decode times is legal, and it is also what several players
 * and at least one large video site handle worst. */
export function videoTiming(samples, slots, ranks, timescale, model) {
  const n = samples.length;
  const timing = { timescale, model, dts: [], ctts: [], durations: [], sync: [], delay: 0 };
  if (!n) return timing;

  const presentation = ranks.map((rank) => slots[rank]);
  let delay = 0;
  for (let i = 0; i < n; i++) delay = Math.max(delay, slots[i] - presentation[i]);

  timing.dts = slots.slice(0, n);
  timing.ctts = presentation.map((value, i) => value + delay - slots[i]);
  timing.delay = delay;

  const durations = [];
  for (let i = 0; i < n - 1; i++) durations.push(slots[i + 1] - slots[i]);
  durations.push(durations.length ? durations[durations.length - 1] : Math.max(1, Math.round(timescale / 30)));
  timing.durations = durations;
  timing.sync = samples.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
  return timing;
}

/* --- writing the index ------------------------------------------------- */

function timeToSample(durations) {
  return table('stts', runLengthEncode(durations).map(([count, value]) => concat([u32(count), u32(value)])));
}

function compositionOffsets(values) {
  return table('ctts', runLengthEncode(values).map(([count, value]) => concat([u32(count), u32(value)])));
}

function sampleToChunk(perChunk) {
  const entries = [];
  let first = 1;
  for (const [count, value] of runLengthEncode(perChunk)) {
    entries.push(concat([u32(first), u32(value), u32(1)]));
    first += count;
  }
  return table('stsc', entries);
}

function sampleSizes(sizes) {
  const uniform = sizes.length && sizes.every((s) => s === sizes[0]) ? sizes[0] : 0;
  if (uniform) return fullBox('stsz', 0, 0, u32(uniform), u32(sizes.length));
  const body = new Uint8Array(sizes.length * 4);
  const view = new DataView(body.buffer);
  sizes.forEach((size, i) => view.setUint32(i * 4, size));
  return fullBox('stsz', 0, 0, u32(0), u32(sizes.length), body);
}

function chunkOffsets(offsets) {
  const last = offsets.length ? offsets[offsets.length - 1] : 0;
  if (last >= 4294967295) return table('co64', offsets.map(u64));
  return table('stco', offsets.map(u32));
}

function editList(track, mediaDuration, movieTimescale) {
  const entries = [];
  if (track.emptyEdit > 0) entries.push(concat([u32(track.emptyEdit), u32(0xffffffff), u32(0x00010000)]));
  const playable = track.discardsHead
    ? Math.max(0, mediaDuration - track.editMediaStart)
    : mediaDuration;
  const movieTicks = track.timescale
    ? Math.floor((playable * movieTimescale) / track.timescale)
    : playable;
  entries.push(concat([u32(movieTicks), u32(track.editMediaStart), u32(0x00010000)]));
  return box('edts', table('elst', entries));
}

function minimalDinf() {
  return box('dinf', table('dref', [fullBox('url ', 0, 1)]));
}

function handlerBox(kind, name) {
  const encoder = new TextEncoder();
  return fullBox('hdlr', 0, 0, new Uint8Array(4), encoder.encode(kind),
                 new Uint8Array(12), encoder.encode(name), new Uint8Array(1));
}

export function buildTrack(track, profile) {
  const mediaDuration = track.durations.reduce((a, b) => a + b, 0);
  const timescale = track.timescale || 1;
  const playable = track.discardsHead
    ? Math.max(0, mediaDuration - track.editMediaStart)
    : mediaDuration;
  const movieDuration = track.emptyEdit + Math.floor((playable * profile.movieTimescale) / timescale);

  const parts = [track.stsd];
  if (track.sgpd) {
    parts.push(track.sgpd);
    parts.push(fullBox('sbgp', 0, 0, new TextEncoder().encode('roll'), u32(1), u32(track.sizes.length), u32(1)));
  }
  parts.push(timeToSample(track.durations));
  if (track.ctts) parts.push(compositionOffsets(track.ctts));
  if (track.sync && track.sync.length && track.sync.length < track.sizes.length) {
    parts.push(table('stss', track.sync.map(u32)));
  }
  parts.push(sampleToChunk(track.samplesPerChunk));
  parts.push(sampleSizes(track.sizes));
  parts.push(chunkOffsets(track.chunkOffsets));
  const stbl = box('stbl', ...parts);

  const header = track.mediaHeader || (track.handler === 'vide'
    ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
    : fullBox('smhd', 0, 0, u16(0), u16(0)));
  const mediaHdlr = track.mediaHdlr || handlerBox(track.handler,
    track.handler === 'vide' ? 'Video Handler' : 'Sound Handler');

  const minfParts = [header];
  if (track.minfHdlr) minfParts.push(track.minfHdlr);
  minfParts.push(track.dinf || minimalDinf());
  minfParts.push(stbl);

  const mdhd = fullBox('mdhd', 0, 0, u32(profile.created), u32(profile.modified),
                       u32(timescale), u32(mediaDuration), u16(track.language || 0x55c4), u16(0));
  const mdia = box('mdia', mdhd, mediaHdlr, box('minf', ...minfParts));

  const tkhd = fullBox('tkhd', 0, 0x0f,
    u32(profile.created), u32(profile.modified), u32(track.trackId), u32(0), u32(movieDuration),
    new Uint8Array(8), u16(0), u16(0), u16(track.volume), u16(0),
    profile.matrix, u32(track.width << 16), u32(track.height << 16));

  const trakParts = [tkhd];
  if (track.tapt) trakParts.push(track.tapt);
  trakParts.push(editList(track, mediaDuration, profile.movieTimescale));
  trakParts.push(mdia);
  return { bytes: box('trak', ...trakParts), duration: movieDuration };
}

export function buildMoov(tracks, profile) {
  if (!tracks.length) throw new Error('there is nothing to build an index for');
  const built = [];
  let longest = 0;
  for (const track of tracks) {
    const result = buildTrack(track, profile);
    built.push(result.bytes);
    longest = Math.max(longest, result.duration);
  }
  const mvhd = fullBox('mvhd', 0, 0,
    u32(profile.created), u32(profile.modified), u32(profile.movieTimescale), u32(longest),
    u32(0x00010000), u16(0x0100), new Uint8Array(10),
    profile.matrix, new Uint8Array(24),
    u32(Math.max(...tracks.map((t) => t.trackId)) + 1));
  return box('moov', mvhd, ...built);
}

export function defaultFtyp() {
  return box('ftyp', new TextEncoder().encode('qt  '), u32(0x20050300), new TextEncoder().encode('qt  '));
}

/* An unfinalised recording over four gigabytes has an eight byte media header
 * and needs a sixteen byte one, and there is nowhere to put the extra bytes
 * without moving the media. Moving it is free when the file is being written
 * out anyway, and every chunk offset shifts by the same amount. */
export function planLayout(ftyp, mediaSize) {
  const needsWide = mediaSize + 8 >= 4294967296;
  const header = needsWide
    ? concat([u32(1), new TextEncoder().encode('mdat'), u64(mediaSize + 16)])
    : concat([u32(mediaSize + 8), new TextEncoder().encode('mdat')]);
  return { mediaOffset: ftyp.length + header.length, header };
}
