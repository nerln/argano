/* The browser engine, checked against the same samples the Python tests use.
 *
 * Two ports of one algorithm drift apart quietly. The way to notice is to make
 * both answer the same question about the same bytes: how many frames are in
 * this file, and where does each one start. ffprobe supplies the truth.
 *
 *     node --test web/lib/engine.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diagnose, repair } from './repair.js';
import { parseBoxes } from './boxes.js';

const work = mkdtempSync(join(tmpdir(), 'argano-js-'));

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_FFMPEG = ffmpegAvailable();

function encode(name, args) {
  const path = join(work, name);
  if (!existsSync(path)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
  }
  return path;
}

function probe(path) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,nb_frames,width,height',
    '-of', 'json', path,
  ]).toString();
  const data = JSON.parse(out);
  const result = { duration: Number(data.format.duration || 0) };
  for (const stream of data.streams || []) {
    result[stream.codec_type] = {
      frames: Number(stream.nb_frames || 0),
      width: Number(stream.width || 0),
      height: Number(stream.height || 0),
    };
  }
  return result;
}

/* Strip the index and blank the media length, which is what a recorder that
 * was interrupted leaves behind. */
function breakFile(source, name) {
  const data = new Uint8Array(readFileSync(source));
  const boxes = parseBoxes(data, 0, data.length);
  const parts = [];
  for (const box of boxes) {
    if (box.name === 'moov') continue;
    parts.push(data.subarray(box.offset, box.end));
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  for (const box of parseBoxes(out, 0, out.length)) {
    if (box.name === 'mdat') out.set([0, 0, 0, 0], box.offset);
  }
  const path = join(work, name);
  writeFileSync(path, out);
  return path;
}

function asFile(path) {
  return new File([readFileSync(path)], path.split('/').pop());
}

const SAMPLE = () => encode('h264-aac.mov', [
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-bf', '2',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-f', 'mov',
]);

test('an unfinalised recording is recognised for what it is', { skip: !HAVE_FFMPEG }, async () => {
  const broken = breakFile(SAMPLE(), 'broken.mov');
  const info = await diagnose(asFile(broken));
  assert.equal(info.unfinalised, true);
  assert.equal(info.needsReference, true);
  assert.ok(info.mediaSize > 0);
  assert.match(info.verdict, /final/);
});

test('every frame comes back', { skip: !HAVE_FFMPEG }, async () => {
  const source = SAMPLE();
  const broken = breakFile(source, 'broken2.mov');
  const result = await repair(asFile(broken), { reference: asFile(source) });
  const truth = probe(source);

  assert.equal(result.videoFrames, truth.video.frames);
  assert.equal(result.audioFrames, truth.audio.frames);
  assert.equal(result.width, truth.video.width);
  assert.equal(result.height, truth.video.height);
  assert.equal(result.damage.length, 0);
});

test('the repaired file plays, and its media is byte for byte the original',
  { skip: !HAVE_FFMPEG }, async () => {
    const source = SAMPLE();
    const broken = breakFile(source, 'broken3.mov');
    const result = await repair(asFile(broken), { reference: asFile(source) });

    const out = join(work, 'fixed.mov');
    writeFileSync(out, Buffer.from(await result.blob.arrayBuffer()));
    const truth = probe(source);
    const fixed = probe(out);
    assert.equal(fixed.video.frames, truth.video.frames);
    assert.ok(Math.abs(fixed.duration - truth.duration) < 0.2,
      `duration ${fixed.duration} against ${truth.duration}`);

    const media = (path) => {
      const data = new Uint8Array(readFileSync(path));
      const mdat = parseBoxes(data, 0, data.length).find((b) => b.name === 'mdat');
      return data.subarray(mdat.payload, mdat.end);
    };
    assert.deepEqual(media(out), media(broken), 'the media was not copied unchanged');
  });

test('a file that still has an index does not need a second one',
  { skip: !HAVE_FFMPEG }, async () => {
    const source = SAMPLE();
    const result = await repair(asFile(source), {});
    assert.equal(result.videoFrames, probe(source).video.frames);
    assert.match(result.profileSource, /own/);
  });

test('with no reference and no index, it says so rather than guessing',
  { skip: !HAVE_FFMPEG }, async () => {
    const broken = breakFile(SAMPLE(), 'broken4.mov');
    await assert.rejects(
      () => repair(asFile(broken), {}),
      (err) => /reference/i.test(err.message),
    );
  });

test('the output has the shape a player expects', { skip: !HAVE_FFMPEG }, async () => {
  const source = SAMPLE();
  const broken = breakFile(source, 'broken5.mov');
  const result = await repair(asFile(broken), { reference: asFile(source) });
  const data = new Uint8Array(await result.blob.arrayBuffer());
  const names = parseBoxes(data, 0, data.length).map((b) => b.name);
  assert.deepEqual(names, ['ftyp', 'mdat', 'moov']);
  assert.equal(result.findings.filter((f) => f.level === 'error').length, 0);
});
