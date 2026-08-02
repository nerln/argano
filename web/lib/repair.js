/* The whole repair, in the browser.
 *
 * Read the file to find out what is wrong with it. Learn the codec settings
 * from a working file, or from the damaged file's own index if enough of it
 * survived. Walk the media and find the frames. Split the sound. Put both back
 * on a clock the sound keeps. Write a new index, then check the result.
 *
 * Nothing is uploaded and nothing is decoded to pixels. The output is built as
 * a Blob whose middle section is a slice of the original File, which the
 * browser keeps as a reference rather than a copy, so a recording of any size
 * can be written out without ever being held in memory.
 */

import {
  audioAnchoredSlots, buildMoov, defaultFtyp, displayOrder, fixedRateSlots,
  planLayout, readProfile, videoTiming,
} from './build.js';
import { findAll, findBox, parseBoxes, readU32 } from './boxes.js';
import { BufferReader, FileReader2 } from './reader.js';
import { Scanner, findParameterSets, pause } from './scan.js';
import { H264, Hevc } from './video.js';
import { parseAudioSpecificConfig, segment } from './aac.js';

const VIDEO_CODECS = { avc1: H264, avc3: H264, hvc1: Hevc, hev1: Hevc };

export class RepairError extends Error {}

/* --- what is wrong with it --------------------------------------------- */

export async function diagnose(file) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 8 << 20)).arrayBuffer());
  const boxes = parseBoxes(head, 0, file.size);
  const result = {
    name: file.name,
    size: file.size,
    topLevel: boxes.map((b) => [b.name, b.offset, b.size]),
    mediaStart: 0, mediaEnd: 0,
    hasIndex: false, indexReadable: false,
    unfinalised: false, truncated: false,
    tracks: [], verdict: '', detail: '',
  };

  const media = boxes.find((b) => b.name === 'mdat');
  if (media) {
    result.mediaStart = media.payload;
    result.mediaEnd = Math.min(media.end, file.size);
    result.truncated = media.truncated;
    /* A recorder writes the length last. Finding it still blank is the
     * signature of a recording that was never closed. */
    result.unfinalised = readU32(head, media.offset) === 0;
  }

  const moovBox = boxes.find((b) => b.name === 'moov');
  if (moovBox) {
    result.hasIndex = true;
    const bytes = new Uint8Array(await file.slice(moovBox.offset, moovBox.end).arrayBuffer());
    const parsed = parseBoxes(bytes, 0, bytes.length);
    const moov = parsed.find((b) => b.name === 'moov');
    if (moov) {
      const traks = findAll(moov, 'trak');
      result.indexReadable = traks.length > 0 && !moov.truncated;
      result.moovBytes = bytes;
      result.moovOffset = moovBox.offset;
      for (const trak of traks) {
        const hdlr = findBox(trak.children, 'mdia/hdlr');
        const stsd = findBox(trak.children, 'mdia/minf/stbl/stsd');
        const kind = hdlr ? String.fromCharCode(...bytes.subarray(hdlr.payload + 8, hdlr.payload + 12)) : 'track';
        const codec = stsd ? String.fromCharCode(...bytes.subarray(stsd.payload + 12, stsd.payload + 16)) : '?';
        result.tracks.push(`${kind}:${codec}`);
      }
    }
  }

  describe(result);
  return result;
}

function describe(result) {
  const mediaSize = Math.max(0, result.mediaEnd - result.mediaStart);
  result.mediaSize = mediaSize;
  result.repairable = mediaSize > 0;
  result.needsReference = result.repairable && !result.indexReadable;

  if (!mediaSize) {
    result.verdict = 'no media found';
    result.detail = 'There is no mdat box holding audio or video, so there is nothing '
      + 'here to rebuild an index around. The file may be a different format than its '
      + 'name suggests.';
    return;
  }
  if (result.indexReadable && !result.unfinalised) {
    result.verdict = 'index present';
    result.detail = 'The file has a readable index. If it still will not play, the '
      + 'problem is inside the media rather than around it, and rebuilding the index '
      + 'from the stream can still help.';
    return;
  }
  if (result.unfinalised) {
    result.verdict = 'recording never finalised';
    result.detail = 'The media length was never filled in, which is what a recorder '
      + `leaves behind when it stops without closing the file. All ${(mediaSize / 1e6).toFixed(0)} MB `
      + 'of media is present and the index that describes it was never written.';
    return;
  }
  if (result.hasIndex) {
    result.verdict = 'index damaged';
    result.detail = 'There is an index and it cannot be read through. The media is '
      + 'intact underneath it and can be indexed again from scratch.';
    return;
  }
  result.verdict = 'index missing';
  result.detail = `The media is ${Math.round((mediaSize / result.size) * 100)} percent of `
    + 'the file and there is no index describing it.';
}

/* --- the repair --------------------------------------------------------- */

export async function repair(file, options = {}) {
  const report = options.onProgress || (() => {});
  report('inspect', 0, 'reading the file structure');
  const diagnosis = options.diagnosis || await diagnose(file);
  if (!diagnosis.repairable) throw new RepairError(diagnosis.detail);

  const { profile, source } = await chooseProfile(file, diagnosis, options.reference);
  const videoCodec = makeVideoCodec(profile.video);
  const audioCodec = makeAudioCodec(profile.audio);

  const reader = new FileReader2(file);

  if (videoCodec && !videoCodec.configured) {
    report('inspect', 0.05, 'looking for codec settings in the stream');
    const found = await findParameterSets(reader, videoCodec, diagnosis.mediaStart, diagnosis.mediaEnd);
    if (!found || !videoCodec.configured) {
      throw new RepairError(
        'The codec settings are not in the reference and the stream does not repeat '
        + 'them. A working file from the same source is needed to read this one.'
      );
    }
  }

  report('scan', 0, 'finding the frames');
  const audioFits = makeAudioFitter(reader, audioCodec);
  const scanner = new Scanner(reader, videoCodec, Boolean(audioCodec), audioFits);
  const scan = await scanner.scan(diagnosis.mediaStart, diagnosis.mediaEnd,
    (fraction) => report('scan', fraction, 'finding the frames'));

  if (!scan.video.length && !scan.audioSpans.length) {
    throw new RepairError(
      'Nothing in the media read as a frame. Either the codec settings do not match '
      + 'this file, or the media is encrypted.'
    );
  }

  report('audio', 0, 'splitting the sound into frames');
  const audio = await segmentAudio(reader, scan, audioCodec, report);

  report('timeline', 0, 'putting the frames back on a clock');
  const ftyp = defaultFtyp();
  const mediaSize = diagnosis.mediaEnd - diagnosis.mediaStart;
  const layout = planLayout(ftyp, mediaSize);
  const shift = layout.mediaOffset - diagnosis.mediaStart;

  const built = buildTracks(scan, audio, profile, videoCodec, audioCodec, options.fps, shift);
  const moov = buildMoov(built.tracks, profile);

  report('write', 0.5, 'assembling the repaired file');
  /* The media is a slice of the original File. A Blob built from it holds a
   * reference, so this line does not read a gigabyte into memory. */
  const blob = new Blob([ftyp, layout.header,
                         file.slice(diagnosis.mediaStart, diagnosis.mediaEnd),
                         moov],
                        { type: 'video/quicktime' });

  report('verify', 0.5, 'checking the result');
  const findings = verifyIndex(ftyp.length + layout.header.length + mediaSize, moov,
                               layout.mediaOffset, mediaSize, profile);

  report('done', 1, '');
  return {
    blob,
    name: suggestName(file.name),
    videoFrames: scan.video.length,
    audioFrames: audio.frames.length,
    duration: built.duration,
    timingModel: built.model,
    width: profile.video ? profile.video.width : 0,
    height: profile.video ? profile.video.height : 0,
    profileSource: source,
    damage: scan.damage,
    droppedAudioFrames: audio.dropped,
    audioNote: audio.note,
    lostSeconds: lostSeconds(scan, built.duration),
    findings,
    reads: reader.reads,
  };
}

function suggestName(name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem} (repaired).mov`;
}

function lostSeconds(scan, duration) {
  const media = scan.video.reduce((a, s) => a + s.size, 0)
    + scan.audioSpans.reduce((a, [, length]) => a + length, 0);
  if (!media || !duration) return 0;
  const damaged = scan.damage.reduce((a, d) => a + d.length, 0);
  return (duration * damaged) / media;
}

async function chooseProfile(file, diagnosis, reference) {
  if (reference) {
    const bytes = new Uint8Array(await readEnoughForIndex(reference));
    return { profile: readProfile(bytes), source: `reference file ${reference.name}` };
  }
  if (diagnosis.indexReadable && diagnosis.moovBytes) {
    /* The index survived, so the file describes itself. Its boxes were read
     * out on their own, so they are given a header to sit behind. */
    return { profile: readProfile(diagnosis.moovBytes), source: "the file's own surviving index" };
  }
  throw new RepairError(
    'This file has no index left to read and no reference was given. Choose a working '
    + 'video from the same camera or app, recorded at the same setting.'
  );
}

/* An index sits at either end of a file, so both ends are read. */
async function readEnoughForIndex(file) {
  if (file.size <= (48 << 20)) return file.arrayBuffer();
  const head = new Uint8Array(await file.slice(0, 8 << 20).arrayBuffer());
  const boxes = parseBoxes(head, 0, file.size);
  const moov = boxes.find((b) => b.name === 'moov');
  if (moov && moov.end <= (8 << 20)) return head.buffer;
  const tail = await file.slice(Math.max(0, file.size - (48 << 20))).arrayBuffer();
  const bytes = new Uint8Array(tail);
  const tailBoxes = parseBoxes(bytes, 0, bytes.length);
  if (tailBoxes.some((b) => b.name === 'moov')) return tail;
  /* The index is neither at the start nor near the end, which a QuickTime file
   * can do. Reading the whole thing is the only way left. */
  return file.arrayBuffer();
}

function makeVideoCodec(track) {
  if (!track) return null;
  const Factory = VIDEO_CODECS[track.fourcc];
  if (!Factory) {
    throw new RepairError(
      `The video is ${track.fourcc}, which this cannot walk yet. H.264 and H.265 are supported.`
    );
  }
  const codec = new Factory();
  if (track.codecConfig && track.codecConfig.length) codec.configure(track.codecConfig);
  if (track.largestSample) {
    /* Eight times the biggest frame the reference holds, and never less than
     * one byte per pixel. The reference may be a short clip of a still scene
     * while the damaged file holds fireworks, so the allowance is generous. */
    codec.maxSampleSize = Math.max(track.largestSample * 8, track.width * track.height);
  }
  return codec;
}

function makeAudioCodec(track) {
  if (!track || track.fourcc !== 'mp4a') return null;
  const asc = extractAsc(track.codecConfig);
  if (!asc || !asc.length) return null;
  try {
    const config = parseAudioSpecificConfig(asc);
    return { config, channels: track.channels, framesFor: (bytes) => segment(bytes, config) };
  } catch (err) {
    return null;
  }
}

/* An esds box is nested tag-length-value records. The configuration wanted is
 * the decoder specific info, tag 5, and it is usually two bytes. */
export function extractAsc(config) {
  if (!config || !config.length) return null;
  if (config.length >= 2 && config.length <= 8) return config;
  let pos = (config[0] === 0 && config[1] === 0 && config[2] === 0) ? 4 : 0;
  while (pos < config.length) {
    const tag = config[pos++];
    let length = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= config.length) return null;
      const byte = config[pos++];
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    if (tag === 0x05) return config.slice(pos, pos + length);
    if (tag === 0x03) {
      const flags = config[pos + 2];
      pos += 3;
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + config[pos];
      if (flags & 0x20) pos += 2;
      continue;
    }
    if (tag === 0x04) { pos += 13; continue; }
    pos += length;
  }
  return null;
}

/* Whether a stretch of bytes is exactly a whole number of audio frames. This
 * is what lets the scan follow a finely interleaved file, where a run of video
 * is one frame and three in a row are never available to confirm against. */
function makeAudioFitter(reader, audioCodec) {
  if (!audioCodec) return null;
  const cache = new Map();
  return async (start, stop) => {
    if (stop <= start) return false;
    const span = `${start}:${stop}`;
    if (cache.has(span)) return cache.get(span);
    const bytes = await reader.bytes(start, stop);
    const result = audioCodec.framesFor(bytes);
    const answer = result.frames.length > 0 && result.skipped === 0;
    if (cache.size < 200000) cache.set(span, answer);
    return answer;
  };
}

async function segmentAudio(reader, scan, audioCodec, report) {
  if (!audioCodec || !scan.audioSpans.length) {
    return { frames: [], perSpan: scan.audioSpans.map(() => 0), dropped: 0, note: '' };
  }
  const frames = [];
  const perSpan = [];
  let dropped = 0;
  const total = scan.audioSpans.length;

  for (let index = 0; index < total; index++) {
    const [offset, length] = scan.audioSpans[index];
    const bytes = await reader.bytes(offset, offset + length);
    const { frames: found, skipped } = audioCodec.framesFor(bytes);
    let kept = found;
    if (skipped) {
      scan.damage.push({ offset, length: skipped, kind: 'unreadable-audio' });
      dropped += 0;
    }
    perSpan.push(kept.length * audioCodec.config.frameLength);
    for (const frame of kept) frames.push({ offset: offset + frame.offset, size: frame.size });
    if (index % 64 === 0) {
      report('audio', index / total, 'splitting the sound into frames');
      await pause();
    }
  }
  return { frames, perSpan, dropped, note: '' };
}

function buildTracks(scan, audio, profile, videoCodec, audioCodec, fps, shift) {
  const tracks = [];
  let duration = 0;
  let model = '';
  let trackId = 1;
  const audioTimescale = audio.frames.length && profile.audio
    ? (profile.audio.sampleRate || profile.audio.timescale) : 0;

  if (scan.video.length && profile.video && videoCodec) {
    let timescale;
    let slots;
    if (audio.frames.length && audioTimescale) {
      timescale = audioTimescale;
      ({ slots, model } = audioAnchoredSlots(scan, audio.perSpan));
    } else {
      timescale = profile.video.timescale || 600;
      ({ slots, model } = fixedRateSlots(scan.video.length, timescale, fps || 30));
    }
    const ranks = displayOrder(scan.video, videoCodec.maxPocLsb);
    const timing = videoTiming(scan.video, slots, ranks, timescale, model);
    const layout = chunkLayout(scan.video);
    tracks.push({
      ...profile.video, timescale, trackId: trackId++,
      sizes: scan.video.map((s) => s.size),
      chunkOffsets: layout.offsets.map((o) => o + shift),
      samplesPerChunk: layout.perChunk,
      durations: timing.durations,
      ctts: timing.ctts.some(Boolean) ? timing.ctts : null,
      sync: timing.sync,
      editMediaStart: timing.delay,
      discardsHead: false,
      volume: 0,
    });
    duration = timing.durations.reduce((a, b) => a + b, 0) / timescale;
  }

  if (audio.frames.length && profile.audio) {
    const layout = contiguousChunks(audio.frames);
    const frameLength = audioCodec.config.frameLength;
    tracks.push({
      ...profile.audio, timescale: audioTimescale, trackId: trackId++,
      sizes: audio.frames.map((f) => f.size),
      chunkOffsets: layout.offsets.map((o) => o + shift),
      samplesPerChunk: layout.perChunk,
      durations: audio.frames.map(() => frameLength),
      ctts: null, sync: null,
      editMediaStart: profile.audio.encoderDelay,
      discardsHead: true,
      volume: 0x0100,
      width: 0, height: 0,
    });
    duration = Math.max(duration, (audio.frames.length * frameLength) / audioTimescale);
  }

  if (!tracks.length) throw new RepairError('Nothing could be indexed out of this file.');
  return { tracks, duration, model };
}

function chunkLayout(samples) {
  const offsets = [];
  const perChunk = [];
  let current = null;
  for (const sample of samples) {
    if (sample.chunk !== current) {
      offsets.push(sample.offset);
      perChunk.push(0);
      current = sample.chunk;
    }
    perChunk[perChunk.length - 1]++;
  }
  return { offsets, perChunk };
}

function contiguousChunks(frames) {
  const offsets = [];
  const perChunk = [];
  let expected = -1;
  for (const frame of frames) {
    if (frame.offset !== expected) {
      offsets.push(frame.offset);
      perChunk.push(0);
    }
    perChunk[perChunk.length - 1]++;
    expected = frame.offset + frame.size;
  }
  return { offsets, perChunk };
}

/* Read the index back the way a strict player would, from byte offsets, and
 * check it against itself. A file whose header is four bytes long still plays
 * in a forgiving player and is stretched everywhere else, so the box lengths
 * the format fixes are checked before anyone is told the job is done. */
function verifyIndex(fileSize, moov, mediaOffset, mediaSize, profile) {
  const findings = [];
  const boxes = parseBoxes(moov, 0, moov.length);
  const root = boxes.find((b) => b.name === 'moov');
  if (!root) {
    findings.push({ level: 'error', message: 'the index came out unreadable' });
    return findings;
  }
  for (const trak of findAll(root, 'trak')) {
    const tkhd = findBox(trak.children, 'tkhd');
    if (!tkhd) continue;
    if (moov[tkhd.payload] === 0 && tkhd.size !== 92) {
      findings.push({
        level: 'error',
        message: `a track header is ${tkhd.size} bytes and must be 92. Every field after `
          + 'the mistake is read from the wrong offset, which is how a correct picture '
          + 'ends up stretched.',
      });
    }
    const stco = findBox(trak.children, 'mdia/minf/stbl/stco');
    if (stco) {
      const count = readU32(moov, stco.payload + 4);
      for (let i = 0; i < count; i++) {
        const offset = readU32(moov, stco.payload + 8 + i * 4);
        if (offset < mediaOffset || offset > mediaOffset + mediaSize) {
          findings.push({ level: 'error', message: 'a chunk points outside the media' });
          break;
        }
      }
    }
  }
  if (profile.video && profile.video.width <= 0) {
    findings.push({ level: 'error', message: 'the picture size came out as zero' });
  }
  return findings;
}
