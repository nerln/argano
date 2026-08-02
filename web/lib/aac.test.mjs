/**
 * The bar for aac.js is every frame boundary, not most of them.
 *
 * A parser that is right 99 percent of the time is worth nothing here. One
 * wrong length puts the reader inside the next frame instead of at the start of
 * it, and from there it either fails on everything after or, worse, keeps
 * finding plausible frames at the wrong offsets. So the vector cases below
 * assert the exact offset and size of every frame, and that not one byte was
 * skipped along the way.
 *
 * Run with `node --test web/lib/aac.test.mjs`, or just `node` on the same file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseAudioSpecificConfig, frameLength, segment } from './aac.js';

const VECTOR_DIR = process.env.AAC_VECTORS || '/tmp/aacvec';
const VECTOR_FILE = join(VECTOR_DIR, 'vectors.json');
const haveVectors = existsSync(VECTOR_FILE);
const skipVectors = haveVectors
  ? false
  : `no vectors at ${VECTOR_FILE}, set AAC_VECTORS to where they live`;
const vectors = haveVectors ? JSON.parse(readFileSync(VECTOR_FILE, 'utf8')) : [];

function bytesFromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The codebook tables read straight out of the module source.
 *
 * They are deliberately not exported: the module's API is three functions, and
 * a table that only a test looks at should not widen it. Lifting the literals
 * out of the text is enough to check them, and it checks the same characters a
 * reader would compare against the standard.
 */
function tableFromSource(name) {
  const source = readFileSync(new URL('./aac.js', import.meta.url), 'utf8');
  const head = `const ${name} = `;
  const start = source.indexOf(head);
  assert.ok(start >= 0, `${name} not found in aac.js`);
  const end = source.indexOf('\n];', start);
  assert.ok(end > start, `${name} has no end in aac.js`);
  const body = source.slice(start + head.length, end + 3);
  const cleaned = body.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[\]}])/g, '$1').replace(/;$/, '');
  return JSON.parse(cleaned);
}

test('every codebook is a complete prefix code', () => {
  const books = tableFromSource('CB_LENGTH_COUNTS');
  const scalefactors = tableFromSource('SF_LENGTH_COUNTS');
  const rows = [['scalefactors', scalefactors], ...books.map((c, i) => [`codebook ${i}`, c])];

  for (const [label, counts] of rows) {
    if (!counts) continue;
    // Kraft equality. A Huffman code that is complete, which every one of these
    // is, has its codeword lengths sum to exactly one this way. A transcription
    // slip almost always breaks it, so this runs before anything reads a frame.
    let total = 0;
    for (let i = 0; i < counts.length; i += 1) total += counts[i] * 2 ** -(i + 1);
    assert.equal(total, 1, `${label} is not a complete code, Kraft sum ${total}`);
  }
});

test('every unsigned codebook names each of its n-tuples once', () => {
  const books = tableFromSource('CB_LENGTH_COUNTS');
  const symbols = tableFromSource('CB_SYMBOLS');
  // Dimension and largest value from table 4.151. A codebook can spell
  // (largest value + 1) raised to its dimension different n-tuples.
  const shape = { 3: [4, 2], 4: [4, 2], 7: [2, 7], 8: [2, 7], 9: [2, 12], 10: [2, 12], 11: [2, 16] };

  for (const [cb, [dimension, largest]] of Object.entries(shape)) {
    const row = symbols[cb];
    const expected = (largest + 1) ** dimension;
    assert.equal(row.length, expected, `codebook ${cb} has ${row.length} symbols, want ${expected}`);
    assert.equal(row.length, books[cb].reduce((a, b) => a + b, 0), `codebook ${cb} size mismatch`);
    assert.deepEqual([...row].sort((a, b) => a - b), [...Array(expected).keys()],
      `codebook ${cb} does not name every n-tuple exactly once`);
  }
});

for (const vector of vectors) {
  test(`${vector.name}: every frame boundary`, { skip: skipVectors }, () => {
    const config = parseAudioSpecificConfig(bytesFromHex(vector.asc));
    assert.ok(config, 'the configuration did not parse');
    assert.equal(config.sampleRate, vector.sample_rate);
    assert.equal(config.channelConfig, vector.channels);
    assert.equal(config.frameLength, vector.samples_per_frame);

    const data = new Uint8Array(readFileSync(join(VECTOR_DIR, `${vector.name}.aac`)));
    assert.equal(data.length, vector.bytes, 'the raw file is not the length the vector claims');

    // One frame at a time first, so a failure names the frame it happened on
    // instead of pointing at wherever the run finally lost its footing.
    for (const [offset, size] of vector.frames) {
      assert.equal(frameLength(data, offset, config), size, `frame at byte ${offset}`);
    }

    const { frames, skipped } = segment(data, config);
    assert.equal(skipped, 0, 'bytes were skipped');
    assert.equal(frames.length, vector.frames.length, 'wrong number of frames');
    assert.deepEqual(frames.map((f) => [f.offset, f.size]), vector.frames);
  });
}

/**
 * A frame written here rather than recorded, because no 960 sample material
 * came with the vectors and the shorter spectrum has to be tested somehow.
 *
 * It is a mono block with one section covering every band of the 44.1 kHz long
 * window layout, coded with spectrum codebook 1, every value zero. The one bit
 * codeword of that codebook and of the scalefactor codebook are both a single
 * zero, so the whole frame is countable by hand: what changes between 1024 and
 * 960 samples is the number of 4-tuples in that section, 256 against 240, and
 * nothing else.
 */
function handWrittenFrame(bands) {
  const bits = [];
  const put = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  put(0, 3); // id_syn_ele: single channel element
  put(0, 4); // element_instance_tag
  put(100, 8); // global_gain
  put(0, 1); // ics_reserved_bit
  put(0, 2); // window_sequence: one long window
  put(0, 1); // window_shape
  put(49, 6); // max_sfb, every band of the 44.1 kHz long layout
  put(0, 1); // predictor_data_present
  put(1, 4); // sect_cb: spectrum codebook 1
  put(31, 5); // sect_len_incr, the escape value
  put(18, 5); // and the remainder, so the section is 49 bands
  for (let i = 0; i < 49; i += 1) put(0, 1); // one scalefactor per band
  put(0, 3); // pulse, tns and gain control all absent
  for (let i = 0; i < bands / 4; i += 1) put(0, 1); // the spectrum itself
  put(7, 3); // id_syn_ele: end
  while (bits.length % 8) bits.push(0);

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) out[i >> 3] |= bits[i] << (7 - (i & 7));
  return out;
}

test('a 960 sample frame stops 16 bits earlier than a 1024 one', () => {
  const long = { objectType: 2, sampleRate: 44100, sampleRateIndex: 4, channelConfig: 1, frameLength: 1024 };
  const short = { ...long, frameLength: 960 };

  const full = handWrittenFrame(1024);
  const clipped = handWrittenFrame(960);
  assert.equal(full.length, 44);
  assert.equal(clipped.length, 42);

  assert.equal(frameLength(full, 0, long), 44);
  assert.equal(frameLength(clipped, 0, short), 42);
  // Each read with the other frame length has to come out somewhere else, or
  // the shorter spectrum is not being counted at all.
  assert.notEqual(frameLength(full, 0, short), 44);
  assert.notEqual(frameLength(clipped, 0, long), 42);
});

test('random bytes are mostly not frames', () => {
  const noise = new Uint8Array(64 * 1024);
  // xorshift32 with a fixed seed. Fixed because a test that fails one run in
  // fifty teaches nothing, and xorshift rather than a plain congruential
  // generator because the low bits of one of those repeat on a short cycle,
  // which makes the same handful of false frames turn up over and over and
  // reads as a much worse result than it is.
  let state = 0x2f6e2b1;
  for (let i = 0; i < noise.length; i += 1) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    noise[i] = state & 0xff;
  }

  // Nothing rules out a run of bytes that happens to be a legal frame: there is
  // no sync word to disagree with and no length to check against. What can be
  // asked is that it stays rare. A mono stream is the loose case, since a lone
  // channel element and an end marker is a short grammar to satisfy by chance.
  for (const channelConfig of [1, 2]) {
    const config = { objectType: 2, sampleRate: 44100, sampleRateIndex: 4, channelConfig, frameLength: 1024 };
    const { frames, skipped } = segment(noise, config);
    const claimed = noise.length - skipped;
    assert.ok(frames.length < 64, `${frames.length} frames found in noise, ${channelConfig} channel`);
    assert.ok(claimed < noise.length * 0.2, `${claimed} of ${noise.length} bytes taken for frames`);
  }
});

test('bad input gets a zero, not an exception', () => {
  const config = { objectType: 2, sampleRate: 44100, sampleRateIndex: 4, channelConfig: 1, frameLength: 1024 };
  const truncated = Uint8Array.from([0x21, 0x1a]);

  assert.equal(frameLength(truncated, 0, config), 0);
  assert.equal(frameLength(new Uint8Array(0), 0, config), 0);
  assert.equal(frameLength(new Uint8Array(16), 99, config), 0);
  assert.equal(frameLength(new Uint8Array(16), -1, config), 0);
  assert.equal(frameLength(null, 0, config), 0);
  assert.equal(frameLength(new Uint8Array(16), 0, null), 0);
  assert.equal(frameLength(new Uint8Array(16), 0, { ...config, objectType: 5 }), 0);
  assert.equal(frameLength(new Uint8Array(16), 0, { ...config, sampleRateIndex: 15 }), 0);
  assert.equal(frameLength(new Uint8Array(16), 0, { ...config, frameLength: 512 }), 0);

  assert.equal(parseAudioSpecificConfig(new Uint8Array(0)), null);
  assert.equal(parseAudioSpecificConfig(Uint8Array.from([0x00])), null);
  assert.deepEqual(segment(null, config), { frames: [], skipped: 0 });
});

test('a truncated frame is not reported as a short one', () => {
  if (!haveVectors) return;
  const vector = vectors[0];
  const config = parseAudioSpecificConfig(bytesFromHex(vector.asc));
  const data = new Uint8Array(readFileSync(join(VECTOR_DIR, `${vector.name}.aac`)));
  // Cut a real frame in half. The parser has to run out of bits and say so.
  const [offset, size] = vector.frames.find((f) => f[1] > 40);
  const half = data.slice(offset, offset + (size >> 1));
  assert.equal(frameLength(half, 0, config), 0);
});
