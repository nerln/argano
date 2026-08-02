/* Walking media that has no index, and finding where each run begins again.
 *
 * A recorder writes in turns: a run of video frames, then the sound that
 * belongs beside them, then the next run of video. Nothing marks the
 * boundaries, so the sound is found by subtraction: it is whatever sits
 * between the end of one run of video and the start of the next.
 *
 * Finding "the start of the next" is the whole problem, and how much evidence
 * is available depends on how the file was written. There are three tests and
 * the nearest position to satisfy any of them wins.
 *
 * Several frames back to back is the strongest. Three consecutive slice
 * headers validating on bytes that are not video effectively does not happen.
 *
 * Some writers interleave far more finely: one frame, a few hundred bytes of
 * sound, one frame. Frames are never adjacent there, so the second test uses
 * the other stream: the gap has to be exactly a whole number of audio frames,
 * with nothing left over, because that is what interleaving means.
 *
 * After real damage neither holds, since noise is not an audio run and the
 * frames around it are not adjacent. The last test asks whether the
 * alternation itself resumes: a frame, a short gap, a frame, a short gap, a
 * frame. Noise does not produce that shape.
 */

import { headerByteTable } from './video.js';

export const CONFIRM_SAMPLES = 3;
export const MIN_AUDIO_RUN = 24;
/* Past this a gap is damage rather than an interleaved run, and asking the
 * audio decoder about it for every candidate stops being worth the time. */
export const AUDIO_FIT_LIMIT = 96 * 1024;
export const CHAIN_GAP = 64 * 1024;
/* Once the weaker test has an answer, how much further to look for a stronger
 * one before settling. Reading the whole window every time turns a job of a
 * minute into most of an hour on a finely interleaved recording. */
export const STRONGER_LOOKAHEAD = 16 * 1024;
export const MAX_CHAIN_ATTEMPTS = 400;

export class Scanner {
  constructor(reader, codec, hasAudio, audioFits = null, confirm = CONFIRM_SAMPLES) {
    this.reader = reader;
    this.codec = codec;
    this.hasAudio = hasAudio;
    this.audioFits = audioFits;
    this.confirm = confirm;
    this.headerBytes = headerByteTable(codec);
    this.lengthSize = codec.nalLengthSize;
  }

  /* Candidate positions, filtered by a byte pattern every real sample start
   * has to match: a length whose top byte is zero, because no single frame is
   * sixteen megabytes, then a NAL header naming a unit type that exists. That
   * rejects almost every offset before any parsing happens. */
  async *candidates(from, to) {
    const ls = this.lengthSize;
    const table = this.headerBytes;
    let pos = from;
    while (pos + ls < to) {
      await this.reader.ensure(pos);
      const view = this.reader.view;
      const base = this.reader.start;
      const stop = Math.min(to - ls, this.reader.end - ls - 1);
      for (let p = pos; p < stop; p++) {
        const i = p - base;
        if (ls >= 3 && view[i] !== 0) continue;
        if (table[view[i + ls]]) yield p;
      }
      pos = Math.max(stop, pos + 1);
    }
  }

  async scan(start, end, onProgress) {
    const video = [];
    const audioSpans = [];
    const damage = [];
    let pos = start;
    let chunk = 0;
    let reported = start;

    while (pos < end) {
      let count = 0;
      while (pos < end) {
        await this.reader.ensure(pos);
        const sample = this.codec.trySample(this.reader.view, this.reader.local(pos), this.reader.localEnd(end));
        if (!sample) break;
        video.push({
          offset: pos, size: sample.size, sync: sample.sync,
          poc: sample.poc, frameNum: sample.frameNum,
          reference: sample.reference, chunk,
        });
        pos += sample.size;
        count++;
      }
      if (count) chunk++;
      if (onProgress && pos - reported > (8 << 20)) {
        onProgress((pos - start) / (end - start));
        reported = pos;
        await pause();
      }
      if (pos >= end) break;

      const gapStart = pos;
      const next = await this.findRestart(pos + 1, end, gapStart);
      if (next === null) {
        const tail = end - gapStart;
        if (this.hasAudio && tail > 0) audioSpans.push([gapStart, tail]);
        else if (tail > 0) {
          damage.push({ offset: gapStart, length: tail, kind: 'unreadable-tail' });
        }
        pos = end;
        break;
      }

      const span = next - gapStart;
      if (count === 0 && video.length === 0) audioSpans.push([gapStart, span]);
      else if (this.hasAudio && span >= MIN_AUDIO_RUN) audioSpans.push([gapStart, span]);
      else damage.push({ offset: gapStart, length: span, kind: 'garbage' });
      pos = next;
    }

    return { video, audioSpans, damage, scannedTo: pos, chunks: chunk };
  }

  async findRestart(start, end, gapStart) {
    for (const window of this.windows(gapStart, start, end)) {
      const found = await this.search(start, window, end, gapStart);
      if (found !== null) return found;
    }
    return null;
  }

  /* Widening bounds, nearest first. The first is the width of a plausible
   * interleaved run, and keeping it tight is what stops weak evidence a few
   * hundred bytes away from beating the strong evidence just behind it. */
  windows(gapStart, start, end) {
    const bounds = [gapStart + AUDIO_FIT_LIMIT, start + (1 << 20), start + (32 << 20)];
    const out = [];
    for (const bound of bounds) {
      const clamped = Math.min(bound, end);
      if (clamped > start && (!out.length || clamped > out[out.length - 1])) out.push(clamped);
    }
    return out;
  }

  async search(start, window, end, gapStart) {
    let fitted = null;
    for await (const offset of this.candidates(start, window)) {
      if (fitted !== null && offset > fitted + STRONGER_LOOKAHEAD) break;
      const run = await this.consecutive(offset, end);
      if (run >= this.confirm) return offset;
      if (fitted === null && run >= 1 && this.audioFits &&
          offset - gapStart <= AUDIO_FIT_LIMIT &&
          await this.audioFits(gapStart, offset)) {
        fitted = offset;
      }
    }
    if (fitted !== null) return fitted;

    let attempts = 0;
    for await (const offset of this.candidates(start, window)) {
      await this.reader.ensure(offset);
      if (!this.codec.trySample(this.reader.view, this.reader.local(offset), this.reader.localEnd(end))) continue;
      if (++attempts > MAX_CHAIN_ATTEMPTS) break;
      if (await this.chain(offset, end) >= this.confirm) return offset;
    }
    return null;
  }

  async consecutive(offset, end) {
    let pos = offset;
    let found = 0;
    while (found < this.confirm) {
      if (pos >= end) break;
      await this.reader.ensure(pos);
      const sample = this.codec.trySample(this.reader.view, this.reader.local(pos), this.reader.localEnd(end));
      if (!sample) break;
      pos += sample.size;
      found++;
    }
    /* Running out of media is not a failure. The last run of a recording is
     * usually short. */
    if (pos >= end && found) return this.confirm;
    return found;
  }

  async chain(offset, end) {
    let pos = offset;
    let samples = 0;
    for (let round = 0; round < this.confirm; round++) {
      let found = 0;
      while (found < 4) {
        await this.reader.ensure(pos);
        const sample = this.codec.trySample(this.reader.view, this.reader.local(pos), this.reader.localEnd(end));
        if (!sample) break;
        pos += sample.size;
        found++;
      }
      if (found === 0) break;
      samples += found;
      if (samples >= this.confirm || pos >= end) break;
      const next = await this.nextParsable(pos + 1, Math.min(end, pos + CHAIN_GAP), end);
      if (next === null) break;
      pos = next;
    }
    return samples;
  }

  async nextParsable(start, window, end) {
    for await (const offset of this.candidates(start, window)) {
      await this.reader.ensure(offset);
      if (this.codec.trySample(this.reader.view, this.reader.local(offset), this.reader.localEnd(end))) {
        return offset;
      }
    }
    return null;
  }
}

/* Hand the page back for a moment so a long scan does not freeze the window. */
export function pause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* Harvest parameter sets an encoder repeated inside the stream, for files with
 * no reference to read them from. Random data matches the same pattern, and a
 * fabricated set that overwrites the real one makes every genuine frame
 * afterwards fail to validate, so a set has to turn up more than once. */
export async function findParameterSets(reader, codec, start, end) {
  const wanted = codec.name === 'hevc' ? new Set([33, 34]) : new Set([7, 8]);
  const typeOf = codec.name === 'hevc' ? (b) => (b >> 1) & 0x3f : (b) => b & 0x1f;
  const ls = codec.nalLengthSize;
  const seen = new Map();
  const limit = Math.min(end, start + (64 << 20));

  for (let pos = start; pos + ls + 2 < limit; pos++) {
    await reader.ensure(pos);
    const local = reader.local(pos);
    let length = 0;
    for (let i = 0; i < ls; i++) length = length * 256 + reader.view[local + i];
    if (length < 4 || length > 512) continue;
    const header = reader.view[local + ls];
    if (header & 0x80) continue;
    if (!wanted.has(typeOf(header))) continue;
    const nal = reader.view.slice(local + ls, local + ls + length);
    const digest = Array.from(nal).join(',');
    const entry = seen.get(digest);
    if (entry) entry.count++;
    else seen.set(digest, { nal, count: 1 });
  }

  const repeated = [...seen.values()].filter((e) => e.count > 1);
  const chosen = repeated.length ? repeated : [...seen.values()];
  for (const entry of chosen) codec.addParameterSet(entry.nal);
  return chosen.length;
}
