/* Finding video frames in a stream that has no index.
 *
 * Inside an MP4 each NAL unit is written with its length in front, so walking
 * the stream looks like reading a length and stepping over that many bytes.
 * That walk cannot tell you it has gone wrong. Four bytes of compressed picture
 * read as a length give a plausible number often enough that following lengths
 * alone will step into the middle of a frame and keep going.
 *
 * So the length is not trusted. The slice header behind it is read, and its
 * first fields have to land on values the file's own settings agree with.
 * Three Exp-Golomb fields in a row landing legally on bytes that are not video
 * is rare, and that is what keeps a walk aligned over hundreds of thousands of
 * frames.
 *
 * Nothing in here changes any state. The scanner asks "is this a frame" at
 * every offset inside a damaged stretch, and most of those bytes are not video,
 * so a parser that adopted settings it met along the way could be handed a
 * fabricated set by a run of noise and then reject every real frame after it.
 */

import { BitReader, BitError, unescape } from './bits.js';

const HEADER_SCAN = 64;
/* Parameter sets and SEI are tens of bytes. One a megabyte long is a length
 * read out of something that is not video. */
const MAX_PREFIX_NAL = 64 * 1024;
const MAX_NAL = 64 * 1024 * 1024;
/* A picture is introduced by a handful of small units. Without a ceiling on
 * how many, a run of noise can supply a hundred and the sample comes out
 * megabytes long with no picture in it. */
const MAX_PREFIX_NALS = 8;
const MAX_PREFIX_BYTES = 128 * 1024;
const MAX_SLICES_PER_PICTURE = 64;

const H264_VCL = new Set([1, 2, 3, 4, 5]);
const H264_KNOWN = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20]);
const H264_PREFIX = new Set([6, 7, 8, 9, 13, 14, 15]);
const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

const HEVC_IRAP_LOW = 16;
const HEVC_IRAP_HIGH = 23;
const HEVC_PREFIX = new Set([32, 33, 34, 35, 39]);

export class H264 {
  constructor() {
    this.name = 'h264';
    this.nalLengthSize = 4;
    this.sps = new Map();
    this.pps = new Map();
    this.maxSlices = MAX_SLICES_PER_PICTURE;
    this.maxSampleSize = 0;
  }

  get configured() { return this.sps.size > 0 && this.pps.size > 0; }

  /* The largest a single frame may be. Without a ceiling, four bytes of noise
   * read as a length of nine megabytes and the walk accepts a frame that is
   * not there, swallowing everything after it. The bound comes from the
   * reference when there is one. Failing that it comes from the picture: a
   * compressed frame cannot be larger than the same picture uncompressed. */
  get sampleCeiling() {
    if (this.maxSampleSize) return this.maxSampleSize;
    const sps = this.sps.values().next().value;
    if (sps && sps.width && sps.height) return Math.max(1 << 20, sps.width * sps.height * 3);
    return MAX_NAL;
  }

  get maxPocLsb() {
    const first = this.sps.values().next().value;
    return first ? Math.pow(2, first.log2MaxPocLsb) : 0;
  }

  /* Read an avcC record: the length size, then the parameter sets. */
  configure(config) {
    if (config.length < 7) throw new Error('avcC record is too short to be one');
    this.nalLengthSize = (config[4] & 3) + 1;
    let pos = 5;
    let count = config[pos++] & 0x1f;
    for (let i = 0; i < count; i++) {
      const len = (config[pos] << 8) | config[pos + 1];
      pos += 2;
      this.addParameterSet(config.subarray(pos, pos + len));
      pos += len;
    }
    if (pos < config.length) {
      count = config[pos++];
      for (let i = 0; i < count; i++) {
        const len = (config[pos] << 8) | config[pos + 1];
        pos += 2;
        this.addParameterSet(config.subarray(pos, pos + len));
        pos += len;
      }
    }
  }

  addParameterSet(nal) {
    if (!nal.length) return;
    const type = nal[0] & 0x1f;
    try {
      if (type === 7) {
        const sps = parseH264Sps(nal);
        this.sps.set(sps.id, sps);
      } else if (type === 8) {
        const pps = parseH264Pps(nal);
        this.pps.set(pps.id, pps);
      }
    } catch (err) {
      if (!(err instanceof BitError)) throw err;
    }
  }

  /* One access unit at `offset`, or null. `limit` is where the media ends:
   * without it a sample can be read as running past the media and into
   * whatever follows. */
  trySample(data, offset, limit) {
    const end = Math.min(data.length, limit === undefined ? data.length : limit);
    const ls = this.nalLengthSize;
    let pos = offset;
    let seenVcl = false;
    let first = null;
    let slices = 0;
    let lastFirstMb = -1;
    let prefixNals = 0;
    let prefixBytes = 0;

    while (pos + ls + 1 <= end) {
      let length = 0;
      for (let i = 0; i < ls; i++) length = length * 256 + data[pos + i];
      if (length < 1 || length > this.sampleCeiling) break;
      const nalEnd = pos + ls + length;
      if (nalEnd > end) break;

      const header = data[pos + ls];
      if (header & 0x80) break;
      const type = header & 0x1f;
      if (!H264_KNOWN.has(type)) break;

      if (!seenVcl && !H264_VCL.has(type)) {
        if (!H264_PREFIX.has(type) || length > MAX_PREFIX_NAL) break;
        prefixNals++;
        prefixBytes += length;
        if (prefixNals > MAX_PREFIX_NALS || prefixBytes > MAX_PREFIX_BYTES) return null;
      }

      if (H264_VCL.has(type)) {
        const parsed = this.readSliceHeader(data, pos + ls, Math.min(nalEnd, pos + ls + HEADER_SCAN), type);
        if (!parsed) break;
        if (seenVcl) {
          if (parsed.firstMb === 0) break;   // the next picture starts here
          /* Later pieces of one picture have to agree with the first about
           * which picture it is, and each has to start after the one before.
           * Without that, any bytes that read as a slice header keep extending
           * the sample. */
          if (parsed.firstMb <= lastFirstMb) break;
          if (parsed.frameNum !== first.frameNum || parsed.poc !== first.poc) break;
          if (++slices > this.maxSlices) break;
        } else if (parsed.firstMb !== 0) {
          return null;                       // a sample cannot begin mid-picture
        }
        lastFirstMb = parsed.firstMb;
        if (!seenVcl) {
          first = { sync: type === 5, poc: parsed.poc, frameNum: parsed.frameNum,
                    reference: ((header >> 5) & 3) > 0 };
        }
        seenVcl = true;
      } else if (seenVcl) {
        /* The picture is complete. Being strict here is what stops a runaway:
         * the bytes after the last slice are usually sound, and sound read as
         * a NAL header occasionally yields a plausible type and a length of
         * several megabytes. Accepting that once swallows hundreds of frames
         * into one sample. */
        break;
      }
      pos = nalEnd;
    }

    if (!seenVcl || !first) return null;
    return { size: pos - offset, ...first };
  }

  readSliceHeader(data, start, stop, type) {
    try {
      const rbsp = unescape(data, start + 1, stop, HEADER_SCAN);
      const r = new BitReader(rbsp);
      const firstMb = r.ue();
      const sliceType = r.ue();
      if (sliceType > 9) return null;
      const pps = this.pps.get(r.ue());
      if (!pps) return null;
      const sps = this.sps.get(pps.spsId);
      if (!sps) return null;
      /* A slice cannot start past the end of the picture it belongs to. That
       * one bound stops a walk from stringing imaginary slices together. */
      if (firstMb >= sps.pictureMacroblocks) return null;

      if (sps.separateColourPlane) r.u(2);
      const frameNum = r.u(sps.log2MaxFrameNum);

      let fieldPic = 0;
      if (!sps.frameMbsOnly) {
        fieldPic = r.u(1);
        if (fieldPic) r.u(1);
      }
      if (type === 5) {
        if (r.ue() > 65535) return null;   // idr_pic_id
      }
      let poc = null;
      if (sps.pocType === 0) {
        poc = r.u(sps.log2MaxPocLsb);
        if (pps.bottomFieldPicOrder && !fieldPic) r.se();
      }
      return { firstMb, sliceType, poc, frameNum };
    } catch (err) {
      if (err instanceof BitError) return null;
      return null;
    }
  }
}

function parseH264Sps(nal) {
  const r = new BitReader(unescape(nal, 1, nal.length, 256));
  const profile = r.u(8);
  r.u(8);
  r.u(8);
  const sps = { id: r.ue(), separateColourPlane: 0 };
  if (H264_HIGH_PROFILES.has(profile)) {
    const chroma = r.ue();
    if (chroma === 3) sps.separateColourPlane = r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) {
      const count = chroma !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) if (r.u(1)) r.skipScalingList(i < 6 ? 16 : 64);
    }
  }
  sps.log2MaxFrameNum = r.ue() + 4;
  sps.pocType = r.ue();
  sps.log2MaxPocLsb = 0;
  if (sps.pocType === 0) {
    sps.log2MaxPocLsb = r.ue() + 4;
  } else if (sps.pocType === 1) {
    r.u(1); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); r.u(1);
  const widthMbs = r.ue() + 1;
  const heightUnits = r.ue() + 1;
  sps.frameMbsOnly = r.u(1);
  if (!sps.frameMbsOnly) r.u(1);
  sps.width = widthMbs * 16;
  sps.height = heightUnits * 16 * (2 - sps.frameMbsOnly);
  sps.pictureMacroblocks = widthMbs * heightUnits * (2 - sps.frameMbsOnly);
  return sps;
}

function parseH264Pps(nal) {
  const r = new BitReader(unescape(nal, 1, nal.length, 32));
  const id = r.ue();
  const spsId = r.ue();
  r.u(1);
  return { id, spsId, bottomFieldPicOrder: r.u(1) };
}

/* --- H.265 ------------------------------------------------------------- */

export class Hevc {
  constructor() {
    this.name = 'hevc';
    this.nalLengthSize = 4;
    this.sps = new Map();
    this.pps = new Map();
    this.maxSlices = MAX_SLICES_PER_PICTURE;
    this.maxSampleSize = 0;
  }

  get configured() { return this.sps.size > 0 && this.pps.size > 0; }

  get sampleCeiling() {
    if (this.maxSampleSize) return this.maxSampleSize;
    const sps = this.sps.values().next().value;
    if (sps && sps.width && sps.height) return Math.max(1 << 20, sps.width * sps.height * 3);
    return MAX_NAL;
  }

  get maxPocLsb() {
    const first = this.sps.values().next().value;
    return first ? Math.pow(2, first.log2MaxPocLsb) : 0;
  }

  configure(config) {
    if (config.length < 23) throw new Error('hvcC record is too short to be one');
    this.nalLengthSize = (config[21] & 3) + 1;
    const arrays = config[22];
    let pos = 23;
    for (let a = 0; a < arrays; a++) {
      if (pos + 3 > config.length) break;
      const count = (config[pos + 1] << 8) | config[pos + 2];
      pos += 3;
      for (let i = 0; i < count; i++) {
        if (pos + 2 > config.length) break;
        const len = (config[pos] << 8) | config[pos + 1];
        pos += 2;
        this.addParameterSet(config.subarray(pos, pos + len));
        pos += len;
      }
    }
  }

  addParameterSet(nal) {
    if (nal.length < 3) return;
    const type = (nal[0] >> 1) & 0x3f;
    try {
      if (type === 33) {
        const sps = parseHevcSps(nal);
        this.sps.set(sps.id, sps);
      } else if (type === 34) {
        const pps = parseHevcPps(nal);
        this.pps.set(pps.id, pps);
      }
    } catch (err) {
      if (!(err instanceof BitError)) throw err;
    }
  }

  trySample(data, offset, limit) {
    const end = Math.min(data.length, limit === undefined ? data.length : limit);
    const ls = this.nalLengthSize;
    let pos = offset;
    let seenVcl = false;
    let first = null;
    let slices = 0;
    let prefixNals = 0;
    let prefixBytes = 0;

    while (pos + ls + 2 <= end) {
      let length = 0;
      for (let i = 0; i < ls; i++) length = length * 256 + data[pos + i];
      if (length < 2 || length > this.sampleCeiling) break;
      const nalEnd = pos + ls + length;
      if (nalEnd > end) break;

      const b0 = data[pos + ls];
      const b1 = data[pos + ls + 1];
      if (b0 & 0x80) break;
      const type = (b0 >> 1) & 0x3f;
      const layerId = ((b0 & 1) << 5) | (b1 >> 3);
      if (type > 41 || (b1 & 7) === 0 || layerId !== 0) break;

      const isVcl = type < 32;
      if (!seenVcl && !isVcl) {
        if (!HEVC_PREFIX.has(type) || length > MAX_PREFIX_NAL) break;
        prefixNals++;
        prefixBytes += length;
        if (prefixNals > MAX_PREFIX_NALS || prefixBytes > MAX_PREFIX_BYTES) return null;
      }

      if (isVcl) {
        const parsed = this.readSliceHeader(data, pos + ls, Math.min(nalEnd, pos + ls + HEADER_SCAN), type);
        if (!parsed) break;
        if (seenVcl) {
          if (parsed.firstInPic) break;
          if (++slices > this.maxSlices) break;
        } else if (!parsed.firstInPic) {
          return null;
        }
        if (!seenVcl) {
          first = { sync: type >= HEVC_IRAP_LOW && type <= HEVC_IRAP_HIGH,
                    poc: parsed.poc, frameNum: null, reference: true };
        }
        seenVcl = true;
      } else if (seenVcl) {
        break;
      }
      pos = nalEnd;
    }

    if (!seenVcl || !first) return null;
    return { size: pos - offset, ...first };
  }

  readSliceHeader(data, start, stop, type) {
    try {
      const rbsp = unescape(data, start + 2, stop, HEADER_SCAN);
      const r = new BitReader(rbsp);
      const firstInPic = r.u(1) === 1;
      if (type >= HEVC_IRAP_LOW && type <= HEVC_IRAP_HIGH) r.u(1);
      const pps = this.pps.get(r.ue());
      if (!pps) return null;
      const sps = this.sps.get(pps.spsId);
      if (!sps) return null;
      if (!firstInPic) return { firstInPic: false, poc: null };

      for (let i = 0; i < pps.extraSliceHeaderBits; i++) r.u(1);
      if (r.ue() > 2) return null;               // slice_type
      if (pps.outputFlagPresent) r.u(1);
      if (sps.separateColourPlane) r.u(2);
      const poc = (type === 19 || type === 20) ? 0 : r.u(sps.log2MaxPocLsb);
      return { firstInPic: true, poc };
    } catch (err) {
      return null;
    }
  }
}

/* profile_tier_level is variable length and sits in front of everything the
 * sequence parameter set is read for, so its length has to come out exactly. */
function skipProfileTierLevel(r, maxSubLayersMinus1) {
  r.u(2); r.u(1); r.u(5);
  r.u(32); r.u(32); r.u(16); r.u(8);
  const profilePresent = [];
  const levelPresent = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.u(1));
    levelPresent.push(r.u(1));
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) { r.u(32); r.u(32); r.u(24); }
    if (levelPresent[i]) r.u(8);
  }
}

function parseHevcSps(nal) {
  const r = new BitReader(unescape(nal, 2, nal.length, 256));
  r.u(4);
  const maxSubLayers = r.u(3);
  r.u(1);
  skipProfileTierLevel(r, maxSubLayers);
  const sps = { id: r.ue(), separateColourPlane: 0 };
  const chroma = r.ue();
  if (chroma === 3) sps.separateColourPlane = r.u(1);
  sps.width = r.ue();
  sps.height = r.ue();
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
  r.ue(); r.ue();
  sps.log2MaxPocLsb = r.ue() + 4;
  if (sps.log2MaxPocLsb > 16) throw new BitError('order count size out of range');
  return sps;
}

function parseHevcPps(nal) {
  const r = new BitReader(unescape(nal, 2, nal.length, 32));
  const id = r.ue();
  const spsId = r.ue();
  r.u(1);
  const outputFlagPresent = r.u(1);
  return { id, spsId, outputFlagPresent, extraSliceHeaderBits: r.u(3) };
}

/* Byte values a real sample start can have at the NAL header position. The
 * scanner uses this as a first filter, because testing every offset with a
 * full header parse is minutes of work on a long recording. */
export function headerByteTable(codec) {
  const table = new Uint8Array(256);
  if (codec.name === 'hevc') {
    for (let type = 0; type < 42; type++) table[(type << 1) & 0xff] = 1;
  } else {
    for (const type of H264_KNOWN) {
      for (let ref = 0; ref < 4; ref++) table[(ref << 5) | type] = 1;
    }
  }
  return table;
}
