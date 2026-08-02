/* Bit level reading, for the parts of a video stream that are not byte aligned.
 *
 * H.264 and H.265 write their headers as a bit stream and code the numbers in
 * them with Exp-Golomb, so reading a slice header means reading single bits.
 *
 * The other job here is emulation prevention. Inside a NAL unit an encoder may
 * not emit 00 00 00, 00 00 01, 00 00 02 or 00 00 03, because a decoder scanning
 * for a start code would trip over the sequence. It inserts a 03 after any two
 * zero bytes and the reader has to take it back out. Skip that and the first
 * zero-heavy field puts you one byte out of step for the rest of the header.
 */

export class BitError extends Error {}

/* Slice headers live in the first few dozen bytes and the payload behind them
 * can be a megabyte, so callers pass a limit and the unescaping stops there. */
export function unescape(data, start, end, limit) {
  const out = new Uint8Array(Math.min(limit, end - start));
  let written = 0;
  let i = start;
  while (i < end && written < out.length) {
    if (i + 2 < end && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out[written++] = 0;
      if (written < out.length) out[written++] = 0;
      i += 3;
    } else {
      out[written++] = data[i++];
    }
  }
  return out.subarray(0, written);
}

export class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.limit = bytes.length * 8;
  }

  u(n) {
    if (this.pos + n > this.limit) throw new BitError('past the end');
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = (value * 2) + ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  /* Unsigned Exp-Golomb. The cap on the leading zero count is what stops a run
   * of zero bytes being read as an enormous number: no field this looks at is
   * anywhere near that size, so a long prefix means these bytes are not a
   * header. */
  ue() {
    let zeros = 0;
    while (true) {
      if (this.pos >= this.limit) throw new BitError('ran out inside a code');
      if (this.u(1)) break;
      if (++zeros > 31) throw new BitError('prefix too long to be real');
    }
    return zeros === 0 ? 0 : (Math.pow(2, zeros) - 1) + this.u(zeros);
  }

  se() {
    const k = this.ue();
    return k % 2 ? (k + 1) / 2 : -(k / 2);
  }

  skipScalingList(size) {
    let last = 8;
    let next = 8;
    for (let i = 0; i < size; i++) {
      if (next !== 0) next = (last + this.se() + 256) % 256;
      if (next !== 0) last = next;
    }
  }
}
