/* The box structure of MP4 and QuickTime files: reading it, and writing it back.
 *
 * A file is a tree of boxes, each a four byte length, a four byte name, then
 * its content. Two of them carry everything. `mdat` holds the encoded picture
 * and sound. `moov` is the index saying where each frame starts, how long it
 * lasts and what order to show it in. Lose `moov` and the media is intact and
 * nothing can play it.
 *
 * The parser survives files that are wrong, because those are the only files
 * this program is handed. The builder is strict for the opposite reason: a box
 * written four bytes too long still parses and still plays in a forgiving
 * player, and it shifts every field after it for a player that reads by offset.
 */

export const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta',
  'moof', 'traf', 'mvex', 'skip', 'meta', 'ipro', 'sinf', 'schi',
  'tapt', 'wave', 'gmhd',
]);

/* Boxes whose length the format fixes. This table is what catches an
 * off-by-four in a header before it reaches anyone. */
export const FIXED_SIZES = {
  'tkhd:0': 92, 'tkhd:1': 104,
  'mdhd:0': 32, 'mdhd:1': 44,
  'mvhd:0': 108, 'mvhd:1': 120,
  'vmhd:0': 20, 'smhd:0': 16,
};

const text = new TextDecoder('latin1');

export function parseBoxes(data, start, end, depth = 0) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = readU32(data, offset);
    const name = text.decode(data.subarray(offset + 4, offset + 8));
    let headerSize = 8;

    if (size === 1) {
      size = readU64(data, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      /* "To the end of the file", which is how an unfinalised recording leaves
       * its media: the writer never came back to fill the length in. */
      size = end - offset;
    }
    if (size < headerSize) break;
    if (!plausibleName(name)) break;

    const box = {
      name, offset, size, headerSize,
      payload: offset + headerSize,
      end: offset + size,
      truncated: false,
      children: [],
    };
    if (box.end > end) {
      box.truncated = true;
      box.size = end - offset;
      box.end = end;
    }
    if (CONTAINERS.has(name) && depth < 12 && !box.truncated) {
      box.children = parseBoxes(data, box.payload, box.end, depth + 1);
    }
    boxes.push(box);
    if (box.truncated) break;
    offset = box.end;
  }
  return boxes;
}

function plausibleName(name) {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return name.length === 4;
}

export function findBox(boxes, path) {
  const parts = path.split('/');
  let level = boxes;
  let found = null;
  for (const part of parts) {
    found = level.find((b) => b.name === part);
    if (!found) return null;
    level = found.children;
  }
  return found;
}

export function findAll(box, name) {
  const out = [];
  const stack = [...(box.children || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.name === name) out.push(node);
    stack.unshift(...node.children);
  }
  return out;
}

export function readU32(data, offset) {
  return ((data[offset] << 24) >>> 0) + (data[offset + 1] << 16) +
         (data[offset + 2] << 8) + data[offset + 3];
}

export function readU16(data, offset) {
  return (data[offset] << 8) + data[offset + 1];
}

export function readU64(data, offset) {
  return readU32(data, offset) * 4294967296 + readU32(data, offset + 4);
}

/* --- writing ----------------------------------------------------------- */

export function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

export function u64(value) {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 4294967296));
  view.setUint32(4, value >>> 0);
  return out;
}

export function u16(value) {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

export function concat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const encoder = new TextEncoder();

export function box(name, ...payload) {
  const body = concat(payload);
  return concat([u32(8 + body.length), encoder.encode(name), body]);
}

export class BoxSizeError extends Error {}

export function fullBox(name, version, flags, ...payload) {
  const head = new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
  const built = box(name, head, ...payload);
  const expected = FIXED_SIZES[`${name}:${version}`];
  if (expected !== undefined && built.length !== expected) {
    throw new BoxSizeError(
      `${name} version ${version} must be ${expected} bytes and came out ${built.length}. ` +
      'A wrong length here shifts every field after it, and a player that reads ' +
      'by offset shows a distorted picture.'
    );
  }
  return built;
}

export function runLengthEncode(values) {
  const out = [];
  for (const value of values) {
    if (out.length && out[out.length - 1][1] === value) out[out.length - 1][0]++;
    else out.push([1, value]);
  }
  return out;
}

export function table(name, entries, version = 0, flags = 0, prefix = new Uint8Array(0)) {
  return fullBox(name, version, flags, prefix, u32(entries.length), concat(entries));
}

export const IDENTITY_MATRIX = concat([
  u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000),
]);
