/**
 * Where a raw AAC frame ends, worked out by reading its syntax.
 *
 * Inside an MP4 the frames of an AAC track sit back to back with no sync word
 * and no length field in front of them. The sizes lived in the sample table,
 * and once that is gone the only thing left that still knows where a frame
 * stops is the frame itself. So this reads one the way a decoder reads it, down
 * to the last Huffman codeword of spectral data, and stops at the byte
 * alignment that closes raw_data_block(). No sound is produced and none is
 * needed. The bit position at the end is the whole answer.
 *
 * Written from ISO/IEC 14496-3. The tables are the normative ones from annex
 * 4.A and from subclause 4.5.4, reproduced in the shape this parser reads them
 * in, and every one of them is a complete prefix code whose lengths sum to one
 * under the Kraft equality, which is what aac.test.mjs checks before it looks
 * at a single frame.
 *
 * Object types 2 (AAC-LC) and 4 (AAC-LTP) are read. LTP is LC plus one flag in
 * ics_info() and the long term prediction data behind it. Any other object type
 * returns a length of 0, because a length that is wrong is worse than one that
 * is missing: a recovery tool that trusts a wrong length loses the rest of the
 * stream, while one that admits defeat can step a byte and try again.
 */

// Sampling frequencies in the order the four bit index in the configuration
// gives them. Index 13 and 14 are reserved, index 15 means the rate is written
// out in full instead.
const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0,
  0
];

// Scalefactor band offsets, tables 4.129 to 4.141. Each row is where every band
// starts, and the last number is the end of the last band, so a band's width is
// the gap to the next entry. Rates that share a row share it in the standard too.
const SWB_LONG_96 = [  // 96 and 88.2 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 108, 120, 132,
  144, 156, 172, 188, 212, 240, 276, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1024
];
const SWB_LONG_64 = [  // 64 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 100, 112, 124, 140,
  156, 172, 192, 216, 240, 268, 304, 344, 384, 424, 464, 504, 544, 584, 624, 664, 704, 744, 784,
  824, 864, 904, 944, 984, 1024
];
const SWB_LONG_48 = [  // 48 and 44.1 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160,
  176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704,
  736, 768, 800, 832, 864, 896, 928, 1024
];
const SWB_LONG_32 = [  // 32 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160,
  176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704,
  736, 768, 800, 832, 864, 896, 928, 960, 992, 1024
];
const SWB_LONG_24 = [  // 24 and 22.05 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 52, 60, 68, 76, 84, 92, 100, 108, 116, 124, 136,
  148, 160, 172, 188, 204, 220, 240, 260, 284, 308, 336, 364, 396, 432, 468, 508, 552, 600, 652,
  704, 768, 832, 896, 960, 1024
];
const SWB_LONG_16 = [  // 16, 12 and 11.025 kHz
  0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 100, 112, 124, 136, 148, 160, 172, 184, 196,
  212, 228, 244, 260, 280, 300, 320, 344, 368, 396, 424, 456, 492, 532, 572, 616, 664, 716, 772,
  832, 896, 960, 1024
];
const SWB_LONG_8 = [  // 8 kHz
  0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 172, 188, 204, 220, 236, 252, 268,
  288, 308, 328, 348, 372, 396, 420, 448, 476, 508, 544, 580, 620, 664, 712, 764, 820, 880, 944,
  1024
];
const SWB_SHORT_96 = [  // 96, 88.2 and 64 kHz
  0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 92, 128
];
const SWB_SHORT_48 = [  // 48, 44.1 and 32 kHz
  0, 4, 8, 12, 16, 20, 28, 36, 44, 56, 68, 80, 96, 112, 128
];
const SWB_SHORT_24 = [  // 24 and 22.05 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 64, 76, 92, 108, 128
];
const SWB_SHORT_16 = [  // 16, 12 and 11.025 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 60, 72, 88, 108, 128
];
const SWB_SHORT_8 = [  // 8 kHz
  0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 60, 72, 88, 108, 128
];

// Indexed by the sampling frequency index. 7350 Hz (index 12) has no band table
// of its own in the standard, and takes the 8 kHz one.
const SWB_LONG = [SWB_LONG_96, SWB_LONG_96, SWB_LONG_64, SWB_LONG_48, SWB_LONG_48,
  SWB_LONG_32, SWB_LONG_24, SWB_LONG_24, SWB_LONG_16, SWB_LONG_16, SWB_LONG_16,
  SWB_LONG_8, SWB_LONG_8];
const SWB_SHORT = [SWB_SHORT_96, SWB_SHORT_96, SWB_SHORT_96, SWB_SHORT_48,
  SWB_SHORT_48, SWB_SHORT_48, SWB_SHORT_24, SWB_SHORT_24, SWB_SHORT_16,
  SWB_SHORT_16, SWB_SHORT_16, SWB_SHORT_8, SWB_SHORT_8];

// How many scalefactor codewords have each length, from one bit upwards.
// Table 4.A.1, which codes a differential scalefactor and is read for every band
// that carries one. Only the width of the codeword matters here, never its value.
const SF_LENGTH_COUNTS = [
  1, 0, 1, 3, 2, 4, 3, 5, 4, 6, 6, 6, 5, 8, 4, 7, 3, 7, 46
];

// The eleven spectrum codebooks, tables 4.A.2 to 4.A.12, each in two parts.
//
// LENGTH_COUNTS is how many codewords have each length, from one bit upwards.
// SYMBOLS is the codeword index the standard lists, in order of the codeword
// itself. The two together rebuild the annex exactly, because the codewords in
// those tables run consecutively upwards within a length and each length picks
// up where the one before it left off, so no codeword needs to be stored.
//
// A signed codebook needs no SYMBOLS row. Its signs are inside the codeword, so
// nothing that follows depends on which n-tuple was read, and the width of the
// codeword is the whole answer.
const CB_LENGTH_COUNTS = [null,
  // codebook 1, table 4.A.2: signed, 4-tuple, largest value 1
  [1, 0, 0, 0, 8, 0, 24, 0, 24, 8, 16],
  // codebook 2, table 4.A.3: signed, 4-tuple, largest value 1
  [0, 0, 1, 1, 7, 24, 15, 19, 14],
  // codebook 3, table 4.A.4: unsigned, 4-tuple, largest value 2
  [1, 0, 0, 4, 2, 6, 3, 5, 15, 15, 8, 9, 3, 3, 5, 2],
  // codebook 4, table 4.A.5: unsigned, 4-tuple, largest value 2
  [0, 0, 0, 10, 6, 0, 9, 21, 8, 14, 11, 2],
  // codebook 5, table 4.A.6: signed, 2-tuple, largest value 4
  [1, 0, 0, 4, 4, 0, 4, 12, 12, 12, 18, 10, 4],
  // codebook 6, table 4.A.7: signed, 2-tuple, largest value 4
  [0, 0, 0, 9, 0, 16, 13, 8, 23, 8, 4],
  // codebook 7, table 4.A.8: unsigned, 2-tuple, largest value 7
  [1, 0, 2, 1, 0, 4, 5, 10, 14, 15, 8, 4],
  // codebook 8, table 4.A.9: unsigned, 2-tuple, largest value 7
  [0, 0, 1, 5, 7, 10, 14, 15, 8, 4],
  // codebook 9, table 4.A.10: unsigned, 2-tuple, largest value 12
  [1, 0, 2, 1, 0, 4, 3, 8, 11, 20, 31, 38, 32, 14, 4],
  // codebook 10, table 4.A.11: unsigned, 2-tuple, largest value 12
  [0, 0, 0, 3, 8, 14, 17, 25, 31, 41, 22, 8],
  // codebook 11, table 4.A.12: unsigned, 2-tuple, largest value 16
  [0, 0, 0, 2, 6, 7, 16, 59, 55, 95, 43, 6],
];

const CB_SYMBOLS = [null,
  null,  // codebook 1 is signed
  null,  // codebook 2 is signed
  [  // codebook 3
    0, 27, 1, 9, 3, 36, 4, 12, 10, 30, 13, 28, 39, 40, 31, 37, 54, 2, 5, 63, 48, 7, 16, 45, 14,
    66, 6, 21, 15, 18, 11, 57, 49, 22, 42, 43, 46, 33, 34, 19, 67, 41, 64, 32, 8, 17, 75, 51, 29,
    55, 25, 72, 52, 38, 58, 44, 76, 24, 23, 35, 73, 69, 78, 26, 79, 70, 50, 53, 20, 60, 47, 61,
    68, 65, 80, 77, 71, 59, 56, 74, 62
  ],
  [  // codebook 4
    40, 13, 37, 39, 31, 27, 36, 0, 4, 30, 28, 12, 1, 10, 3, 9, 67, 43, 49, 41, 66, 64, 48, 58, 16,
    14, 42, 22, 32, 46, 38, 34, 63, 57, 45, 55, 11, 21, 5, 15, 19, 29, 7, 33, 54, 2, 18, 6, 52,
    76, 70, 44, 50, 68, 51, 75, 69, 25, 17, 73, 23, 61, 35, 79, 47, 59, 65, 53, 71, 77, 24, 72, 8,
    60, 20, 56, 80, 26, 78, 74, 62
  ],
  null,  // codebook 5 is signed
  null,  // codebook 6 is signed
  [  // codebook 7
    0, 8, 1, 9, 17, 10, 16, 2, 25, 11, 18, 24, 3, 19, 26, 12, 33, 13, 41, 27, 20, 4, 32, 34, 21,
    42, 5, 49, 40, 14, 35, 29, 28, 43, 22, 50, 15, 30, 6, 48, 36, 57, 37, 58, 44, 51, 23, 59, 52,
    45, 38, 31, 56, 7, 53, 46, 60, 39, 47, 61, 62, 54, 55, 63
  ],
  [  // codebook 8
    9, 17, 8, 10, 1, 18, 0, 16, 2, 25, 11, 26, 19, 27, 33, 12, 34, 20, 24, 3, 35, 28, 42, 41, 21,
    13, 43, 29, 36, 44, 4, 37, 32, 22, 50, 49, 14, 30, 51, 45, 40, 52, 5, 38, 57, 58, 23, 53, 59,
    15, 46, 31, 54, 60, 48, 39, 6, 61, 62, 55, 47, 56, 7, 63
  ],
  [  // codebook 9
    0, 13, 1, 14, 27, 15, 26, 2, 40, 28, 16, 39, 3, 29, 41, 17, 53, 30, 18, 54, 42, 4, 52, 66, 31,
    19, 43, 67, 79, 55, 5, 32, 65, 20, 44, 21, 105, 56, 68, 80, 92, 6, 106, 34, 45, 33, 57, 118,
    22, 93, 78, 69, 81, 107, 7, 119, 47, 58, 46, 8, 131, 82, 35, 70, 104, 91, 94, 132, 120, 108,
    23, 95, 83, 71, 60, 59, 48, 144, 73, 117, 109, 133, 36, 9, 145, 121, 84, 157, 61, 110, 24,
    122, 134, 72, 96, 37, 25, 158, 146, 49, 74, 85, 111, 147, 10, 97, 159, 130, 135, 62, 86, 38,
    123, 124, 63, 143, 87, 50, 75, 112, 99, 161, 51, 148, 98, 160, 149, 136, 64, 100, 76, 11, 162,
    88, 156, 137, 77, 101, 125, 12, 150, 113, 126, 138, 102, 163, 89, 115, 151, 103, 90, 114, 139,
    116, 127, 128, 129, 141, 165, 140, 152, 164, 153, 166, 167, 142, 154, 155, 168
  ],
  [  // codebook 10
    14, 15, 27, 28, 13, 1, 16, 41, 40, 29, 42, 26, 2, 30, 54, 17, 53, 0, 55, 43, 39, 3, 56, 31,
    67, 18, 66, 68, 44, 69, 57, 80, 32, 81, 52, 79, 4, 19, 45, 70, 82, 58, 83, 93, 46, 33, 71,
    106, 94, 65, 92, 5, 105, 20, 107, 95, 59, 34, 84, 96, 21, 47, 108, 60, 72, 109, 73, 97, 85,
    119, 78, 86, 120, 48, 118, 35, 6, 110, 121, 61, 132, 22, 98, 111, 122, 99, 133, 74, 134, 36,
    131, 49, 123, 87, 104, 62, 91, 145, 100, 146, 136, 23, 144, 124, 7, 112, 135, 50, 75, 113,
    148, 8, 147, 37, 101, 88, 137, 63, 24, 158, 125, 159, 149, 76, 160, 150, 161, 51, 89, 117,
    138, 130, 157, 9, 64, 126, 162, 38, 114, 127, 25, 151, 163, 102, 77, 90, 139, 115, 164, 10,
    103, 143, 140, 152, 153, 11, 154, 128, 141, 156, 116, 165, 142, 129, 155, 167, 12, 166, 168
  ],
  [  // codebook 11
    0, 18, 288, 17, 1, 35, 19, 36, 20, 52, 53, 34, 37, 2, 54, 69, 21, 70, 38, 71, 55, 51, 3, 86,
    87, 39, 72, 22, 88, 56, 89, 73, 104, 40, 103, 105, 57, 23, 84, 67, 277, 275, 276, 106, 278,
    68, 74, 4, 50, 90, 101, 279, 274, 280, 41, 121, 58, 107, 91, 118, 282, 122, 120, 281, 135, 33,
    24, 75, 283, 123, 284, 152, 273, 108, 169, 42, 92, 186, 285, 139, 138, 59, 85, 286, 203, 124,
    76, 109, 125, 5, 140, 287, 220, 25, 137, 254, 93, 237, 60, 141, 126, 43, 142, 155, 156, 271,
    77, 110, 102, 157, 94, 143, 127, 26, 173, 6, 172, 154, 158, 78, 44, 159, 61, 111, 174, 144,
    175, 160, 190, 27, 119, 176, 128, 62, 95, 171, 79, 189, 223, 112, 224, 45, 272, 96, 192, 191,
    161, 129, 145, 16, 81, 7, 64, 193, 222, 225, 207, 47, 226, 146, 113, 178, 177, 240, 208, 28,
    80, 188, 63, 30, 206, 130, 65, 97, 98, 242, 82, 194, 241, 209, 227, 210, 136, 195, 46, 162,
    243, 115, 180, 257, 147, 163, 244, 179, 99, 196, 239, 48, 114, 29, 229, 8, 228, 131, 211, 132,
    258, 205, 116, 49, 260, 259, 31, 164, 83, 245, 149, 230, 148, 100, 66, 181, 197, 212, 261,
    262, 150, 256, 133, 153, 9, 166, 165, 213, 246, 183, 247, 214, 117, 134, 167, 263, 198, 201,
    32, 182, 184, 232, 231, 200, 199, 151, 249, 233, 217, 264, 248, 170, 215, 168, 10, 216, 187,
    218, 185, 234, 13, 250, 265, 266, 202, 251, 221, 11, 235, 267, 268, 219, 238, 252, 236, 204,
    253, 14, 12, 269, 255, 15, 270
  ],
];

// Element types, the three bits that open every syntactic element.
const ID_SCE = 0;
const ID_CPE = 1;
const ID_CCE = 2;
const ID_LFE = 3;
const ID_DSE = 4;
const ID_PCE = 5;
const ID_FIL = 6;
const ID_END = 7;

const ONLY_LONG_SEQUENCE = 0;
const EIGHT_SHORT_SEQUENCE = 2;

// Codebook numbers that are not codebooks. Zero means the band is silent, 13
// means its content is noise described by an energy, 14 and 15 mean the band is
// steered from the other channel of a pair. None of those four sends spectral
// data, so anything from 13 up is skipped the same way. 12 is reserved and
// never legal, which makes it a cheap sign that the bits are not a frame.
const ZERO_HCB = 0;
const ESC_HCB = 11;
const RESERVED_HCB = 12;
const NOISE_HCB = 13;

// Table 4.151, for codebooks 1 to 11.
const CB_DIMENSION = [0, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 2];
const CB_LARGEST_VALUE = [0, 1, 1, 2, 2, 4, 4, 7, 7, 12, 12, 16];

// 32 kHz long windows have 51 bands, more than any other rate, and a section is
// at least one band wide, so 51 also bounds the number of sections in a group.
const MAX_BANDS = 51;
const MAX_WINDOW_GROUPS = 8;

// The bit reservoir may not carry a frame past 6144 bits per channel
// (subclause 4.5.3.1). A parse that runs longer than that has gone wrong,
// whatever the bits looked like on the way.
const MAX_BITS_PER_CHANNEL = 6144;

// A guard, not a rule from the standard. Every element consumes bits, so the
// loop over them always ends, and this only stops a damaged frame from being
// read as thousands of tiny elements before the size check rejects it anyway.
const MAX_ELEMENTS = 64;

/**
 * What follows an unsigned codeword, precomputed for every codeword.
 *
 * The number of sign bits is the number of values in the n-tuple that are not
 * zero, and for the escape codebook the number of escape sequences is the
 * number of values that came out as 16. Both depend only on which n-tuple the
 * codeword stands for, so both are worked out once here, from the index to
 * n-tuple rule in subclause 4.6.3.3, rather than per codeword read.
 */
const CB_SIGN_BITS = [];
const CB_ESCAPES = [];
for (let cb = 0; cb < CB_SYMBOLS.length; cb += 1) {
  const symbols = CB_SYMBOLS[cb];
  if (!symbols) {
    CB_SIGN_BITS.push(null);
    CB_ESCAPES.push(null);
    continue;
  }
  const dimension = CB_DIMENSION[cb];
  const modulus = CB_LARGEST_VALUE[cb] + 1;
  const signs = new Uint8Array(symbols.length);
  const escapes = new Uint8Array(symbols.length);
  for (let rank = 0; rank < symbols.length; rank += 1) {
    let rest = symbols[rank];
    for (let d = 0; d < dimension; d += 1) {
      const value = rest % modulus;
      rest = (rest - value) / modulus;
      if (value !== 0) signs[rank] += 1;
      if (value === 16) escapes[rank] += 1;
    }
  }
  CB_SIGN_BITS.push(signs);
  CB_ESCAPES.push(escapes);
}

/**
 * A reader over a byte array, counted in bits.
 *
 * Running off the end sets `ok` and hands back zeros from then on. Nothing
 * throws, which is what lets the parser walk into rubbish and come back with a
 * refusal instead of an exception. Callers check `ok` at every point where a
 * value read could otherwise steer a loop.
 */
class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.end = bytes.length * 8;
    this.pos = 0;
    this.ok = true;
  }

  seek(bitPosition) {
    this.pos = bitPosition;
    this.ok = bitPosition <= this.end;
  }

  read1() {
    const pos = this.pos;
    if (pos >= this.end) {
      this.ok = false;
      return 0;
    }
    this.pos = pos + 1;
    return (this.bytes[pos >> 3] >> (7 - (pos & 7))) & 1;
  }

  read(count) {
    if (count <= 0) return 0;
    if (this.pos + count > this.end) {
      this.pos = this.end;
      this.ok = false;
      return 0;
    }
    let pos = this.pos;
    let want = count;
    let value = 0;
    while (want > 0) {
      const spare = 8 - (pos & 7);
      const take = spare < want ? spare : want;
      const byte = this.bytes[pos >> 3];
      value = (value << take) | ((byte >> (spare - take)) & ((1 << take) - 1));
      pos += take;
      want -= take;
    }
    this.pos = pos;
    return value;
  }

  skip(count) {
    if (this.pos + count > this.end) {
      this.pos = this.end;
      this.ok = false;
      return;
    }
    this.pos += count;
  }

  align() {
    this.skip((8 - (this.pos & 7)) & 7);
  }
}

/**
 * Read one canonical Huffman codeword and return its position in the codebook.
 *
 * `counts` holds how many codewords have each length, counting from one bit.
 * Because the codewords of a length run consecutively and each length picks up
 * from the one before it, the value read so far can be compared against the
 * first codeword of the current length without holding any codeword in memory.
 * The position returned indexes the codebook's SYMBOLS row.
 */
function readCodeword(reader, counts) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 0; length < counts.length; length += 1) {
    code |= reader.read1();
    const count = counts[length];
    if (code - first < count) return index + (code - first);
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  // Every codebook is a complete code, so this is only reached once the reader
  // has run dry and is feeding zeros.
  reader.ok = false;
  return 0;
}

/**
 * Skip one escape sequence: N ones, a zero, then N+4 bits (subclause 4.6.3.3).
 *
 * The standard holds the whole sequence under 22 bits, which caps N at 8. A
 * longer run of ones is not a legal escape, and reading it as one would swallow
 * an arbitrary amount of the stream, so it fails the frame instead.
 */
function skipEscapeSequence(reader) {
  let n = 0;
  while (reader.read1() === 1) {
    n += 1;
    if (n > 8) return false;
  }
  reader.skip(n + 4);
  return reader.ok;
}

/** Room for one channel's side information, reused across frames. */
function newChannelInfo() {
  return {
    windowSequence: ONLY_LONG_SEQUENCE,
    maxSfb: 0,
    numWindowGroups: 1,
    groupLength: new Int32Array(MAX_WINDOW_GROUPS),
    numSec: new Int32Array(MAX_WINDOW_GROUPS),
    sectCb: new Int32Array(MAX_WINDOW_GROUPS * MAX_BANDS),
    sectStart: new Int32Array(MAX_WINDOW_GROUPS * MAX_BANDS),
    sectEnd: new Int32Array(MAX_WINDOW_GROUPS * MAX_BANDS),
    sfbCb: new Int32Array(MAX_WINDOW_GROUPS * MAX_BANDS),
    bandOffsets: null,
    numSwb: 0,
    spectrumLimit: 0,
  };
}

// Two of these are enough for any element: a pair is the widest thing there is.
// They are held here because resynchronising tries every byte offset in turn,
// and building them again at each offset would cost more than the parse does.
const SCRATCH = [newChannelInfo(), newChannelInfo()];

/** Copy the window layout a channel pair shares between its two channels. */
function shareWindowInfo(from, to) {
  to.windowSequence = from.windowSequence;
  to.maxSfb = from.maxSfb;
  to.numWindowGroups = from.numWindowGroups;
  to.bandOffsets = from.bandOffsets;
  to.numSwb = from.numSwb;
  to.spectrumLimit = from.spectrumLimit;
  for (let g = 0; g < from.numWindowGroups; g += 1) to.groupLength[g] = from.groupLength[g];
}

/** ltp_data(), table 4.55. Read for object type 4 only. */
function readLtpData(reader, info) {
  reader.skip(11 + 3); // ltp_lag, ltp_coef
  if (info.windowSequence !== EIGHT_SHORT_SEQUENCE) {
    // MAX_LTP_LONG_SFB is 40 (subclause 4.6.7.2).
    reader.skip(info.maxSfb < 40 ? info.maxSfb : 40);
  }
  return reader.ok;
}

/** ics_info(), table 4.6. */
function readIcsInfo(reader, config, info, commonWindow) {
  // ics_reserved_bit. A reserved field is written as zero, and refusing a one
  // here throws out about half of the offsets in damaged bytes that would
  // otherwise read as a plausible short frame. If an encoder ever turns up that
  // writes something else, this is the line that will reject its every frame.
  if (reader.read1()) return false;
  info.windowSequence = reader.read(2);
  reader.read1(); // window_shape
  const short = info.windowSequence === EIGHT_SHORT_SEQUENCE;

  if (short) {
    info.maxSfb = reader.read(4);
    // Seven bits, one per window after the first. A set bit puts that window in
    // the same group as the one before it, so the groups partition the eight
    // short windows and their lengths multiply the band widths later on.
    const grouping = reader.read(7);
    info.numWindowGroups = 1;
    info.groupLength[0] = 1;
    for (let i = 0; i < 7; i += 1) {
      if ((grouping >> (6 - i)) & 1) {
        info.groupLength[info.numWindowGroups - 1] += 1;
      } else {
        info.groupLength[info.numWindowGroups] = 1;
        info.numWindowGroups += 1;
      }
    }
  } else {
    info.maxSfb = reader.read(6);
    info.numWindowGroups = 1;
    info.groupLength[0] = 1;
    if (reader.read1()) {
      // predictor_data_present. For object type 2 this bit has to be zero: what
      // sits behind it is backward prediction, which belongs to AAC Main, or
      // long term prediction, which belongs to object type 4.
      if (config.objectType !== 4) return false;
      if (reader.read1() && !readLtpData(reader, info)) return false;
      if (commonWindow && reader.read1() && !readLtpData(reader, info)) return false;
    }
  }

  const table = short ? SWB_SHORT[config.sampleRateIndex] : SWB_LONG[config.sampleRateIndex];
  info.bandOffsets = table;
  if (config.frameLength === 960) {
    // A 960 sample frame keeps the band layout and loses whatever runs past its
    // shorter spectrum. That is what the bracketed values in tables 4.129 to
    // 4.141 amount to: at 44.1 kHz only the closing offset moves down to 960,
    // at 32 kHz the band that would have started there goes with it.
    const limit = short ? 120 : 960;
    let bands = 0;
    while (bands < table.length - 1 && table[bands] < limit) bands += 1;
    info.numSwb = bands;
    info.spectrumLimit = limit;
  } else {
    info.numSwb = table.length - 1;
    info.spectrumLimit = 0;
  }
  if (info.maxSfb > info.numSwb) return false;
  return reader.ok;
}

/** The first spectral coefficient past band `sfb`, in a 960 sample frame too. */
function bandEdge(info, sfb) {
  const offset = info.bandOffsets[sfb];
  if (info.spectrumLimit && offset > info.spectrumLimit) return info.spectrumLimit;
  return offset;
}

/** section_data(), table 4.52. */
function readSectionData(reader, info) {
  const incrBits = info.windowSequence === EIGHT_SHORT_SEQUENCE ? 3 : 5;
  const escape = (1 << incrBits) - 1;

  for (let g = 0; g < info.numWindowGroups; g += 1) {
    const base = g * MAX_BANDS;
    let band = 0;
    let section = 0;
    while (band < info.maxSfb) {
      if (!reader.ok || section >= MAX_BANDS) return false;
      const cb = reader.read(4);
      if (cb === RESERVED_HCB) return false;
      // The length arrives as a run of escape values ending in a smaller one.
      let length = 0;
      let increment = escape;
      while (increment === escape && reader.ok) {
        increment = reader.read(incrBits);
        length += increment;
        if (length > MAX_BANDS) return false;
      }
      // A section of no bands would leave the loop standing still. The standard
      // has no use for one, and damaged bits are the only thing that produces it.
      if (length === 0 || band + length > info.maxSfb) return false;
      info.sectCb[base + section] = cb;
      info.sectStart[base + section] = band;
      info.sectEnd[base + section] = band + length;
      for (let sfb = band; sfb < band + length; sfb += 1) info.sfbCb[base + sfb] = cb;
      band += length;
      section += 1;
    }
    info.numSec[g] = section;
  }
  return reader.ok;
}

/** scale_factor_data(), table 4.53. */
function readScaleFactorData(reader, info) {
  // The first noise band sends its energy as a plain 9 bit number and every
  // later one sends a difference. Missing this makes the frame come out 8 bits
  // short, which is enough to lose the rest of the file.
  let noiseIsPcm = true;
  for (let g = 0; g < info.numWindowGroups; g += 1) {
    const base = g * MAX_BANDS;
    for (let sfb = 0; sfb < info.maxSfb; sfb += 1) {
      const cb = info.sfbCb[base + sfb];
      if (cb === ZERO_HCB) continue;
      if (cb === NOISE_HCB && noiseIsPcm) {
        noiseIsPcm = false;
        reader.skip(9);
      } else {
        readCodeword(reader, SF_LENGTH_COUNTS);
      }
      if (!reader.ok) return false;
    }
  }
  return true;
}

/** pulse_data(), table 4.7. */
function readPulseData(reader) {
  const pulses = reader.read(2);
  reader.skip(6); // pulse_start_sfb
  reader.skip((pulses + 1) * (5 + 4));
  return reader.ok;
}

/** tns_data(), table 4.54. */
function readTnsData(reader, info) {
  const short = info.windowSequence === EIGHT_SHORT_SEQUENCE;
  const windows = short ? 8 : 1;
  const filterBits = short ? 1 : 2;
  const lengthBits = short ? 4 : 6;
  const orderBits = short ? 3 : 5;

  for (let w = 0; w < windows; w += 1) {
    const filters = reader.read(filterBits);
    let resolution = 0;
    if (filters) resolution = reader.read1();
    for (let filter = 0; filter < filters; filter += 1) {
      reader.skip(lengthBits);
      const order = reader.read(orderBits);
      if (order) {
        reader.read1(); // direction
        const compress = reader.read1();
        // The resolution bit widens each coefficient and the compression bit
        // narrows it, so a coefficient is 2, 3 or 4 bits.
        reader.skip(order * (resolution + 3 - compress));
      }
      if (!reader.ok) return false;
    }
  }
  return reader.ok;
}

/** spectral_data(), table 4.56. */
function readSpectralData(reader, info) {
  for (let g = 0; g < info.numWindowGroups; g += 1) {
    const base = g * MAX_BANDS;
    const groupLength = info.groupLength[g];
    for (let i = 0; i < info.numSec[g]; i += 1) {
      const cb = info.sectCb[base + i];
      // Silent, noise and intensity sections send no spectrum.
      if (cb === ZERO_HCB || cb >= NOISE_HCB) continue;

      const from = bandEdge(info, info.sectStart[base + i]);
      const to = bandEdge(info, info.sectEnd[base + i]);
      // Grouped short windows put the same band of every window in the group
      // side by side, so a section holds its band widths once per window.
      const coefficients = (to - from) * groupLength;
      const dimension = CB_DIMENSION[cb];
      const counts = CB_LENGTH_COUNTS[cb];
      const signBits = CB_SIGN_BITS[cb];
      const escapes = cb === ESC_HCB ? CB_ESCAPES[cb] : null;

      for (let k = 0; k < coefficients; k += dimension) {
        const rank = readCodeword(reader, counts);
        if (!reader.ok) return false;
        if (signBits) {
          reader.skip(signBits[rank]);
          if (escapes) {
            for (let e = escapes[rank]; e > 0; e -= 1) {
              if (!skipEscapeSequence(reader)) return false;
            }
          }
        }
      }
    }
  }
  return reader.ok;
}

/** individual_channel_stream(), table 4.50. */
function readChannelStream(reader, config, info, commonWindow) {
  reader.skip(8); // global_gain
  if (!commonWindow && !readIcsInfo(reader, config, info, false)) return false;
  if (!readSectionData(reader, info)) return false;
  if (!readScaleFactorData(reader, info)) return false;

  if (reader.read1()) {
    // The pulse escape is not allowed under eight short windows (subclause
    // 4.6.3.3), so a frame that claims it there is not this stream's frame.
    if (info.windowSequence === EIGHT_SHORT_SEQUENCE) return false;
    if (!readPulseData(reader)) return false;
  }
  if (reader.read1() && !readTnsData(reader, info)) return false;
  // gain_control_data() belongs to AAC SSR. Under object type 2 or 4 the flag
  // is written and has to be zero.
  if (reader.read1()) return false;
  if (!reader.ok) return false;

  return readSpectralData(reader, info);
}

/** single_channel_element() and lfe_channel_element(), tables 4.4 and 4.9. */
function readSingleChannel(reader, config) {
  reader.skip(4); // element_instance_tag
  return readChannelStream(reader, config, SCRATCH[0], false);
}

/** channel_pair_element(), table 4.5. */
function readChannelPair(reader, config) {
  reader.skip(4); // element_instance_tag
  const commonWindow = reader.read1();
  if (!reader.ok) return false;

  if (commonWindow) {
    if (!readIcsInfo(reader, config, SCRATCH[0], true)) return false;
    shareWindowInfo(SCRATCH[0], SCRATCH[1]);
    const msMaskPresent = reader.read(2);
    if (msMaskPresent === 1) {
      reader.skip(SCRATCH[0].numWindowGroups * SCRATCH[0].maxSfb);
    }
    if (!reader.ok) return false;
  }
  if (!readChannelStream(reader, config, SCRATCH[0], commonWindow)) return false;
  return readChannelStream(reader, config, SCRATCH[1], commonWindow);
}

/** coupling_channel_element(), table 4.8. */
function readCouplingChannel(reader, config) {
  reader.skip(4); // element_instance_tag
  const independent = reader.read1();
  const coupled = reader.read(3);
  let gainLists = 0;
  for (let c = 0; c <= coupled; c += 1) {
    gainLists += 1;
    const targetIsPair = reader.read1();
    reader.skip(4); // cc_target_tag_select
    if (targetIsPair) {
      const left = reader.read1();
      const right = reader.read1();
      if (left && right) gainLists += 1;
    }
  }
  reader.skip(1 + 1 + 2); // cc_domain, gain_element_sign, gain_element_scale
  if (!reader.ok) return false;

  const info = SCRATCH[0];
  if (!readChannelStream(reader, config, info, false)) return false;

  // One gain per list. Either a single value for the whole list, or a value for
  // every band that carries spectrum, which is why this has to come after the
  // channel stream: it is the section data of that stream that says which.
  for (let c = 1; c < gainLists; c += 1) {
    let common = independent;
    if (!independent) common = reader.read1();
    if (common) {
      readCodeword(reader, SF_LENGTH_COUNTS);
    } else {
      for (let g = 0; g < info.numWindowGroups; g += 1) {
        for (let sfb = 0; sfb < info.maxSfb; sfb += 1) {
          if (info.sfbCb[g * MAX_BANDS + sfb] !== ZERO_HCB) {
            readCodeword(reader, SF_LENGTH_COUNTS);
          }
        }
      }
    }
    if (!reader.ok) return false;
  }
  return true;
}

/** data_stream_element(), table 4.10. */
function readDataStream(reader) {
  reader.skip(4); // element_instance_tag
  const alignFirst = reader.read1();
  let count = reader.read(8);
  if (count === 255) count += reader.read(8);
  if (!reader.ok) return false;
  if (alignFirst) reader.align();
  reader.skip(count * 8);
  return reader.ok;
}

/** program_config_element(), table 4.2. */
function readProgramConfig(reader) {
  reader.skip(4 + 2 + 4); // tag, object type, sampling frequency index
  const front = reader.read(4);
  const side = reader.read(4);
  const back = reader.read(4);
  const lfe = reader.read(2);
  const assoc = reader.read(3);
  const coupling = reader.read(4);
  if (reader.read1()) reader.skip(4); // mono downmix
  if (reader.read1()) reader.skip(4); // stereo downmix
  if (reader.read1()) reader.skip(3); // matrix downmix
  if (!reader.ok) return false;
  // Five bits per front, side and back element (a flag and a tag), four per LFE
  // and per associated data element, five per coupling element.
  reader.skip((front + side + back) * 5 + lfe * 4 + assoc * 4 + coupling * 5);
  reader.align();
  const comment = reader.read(8);
  reader.skip(comment * 8);
  return reader.ok;
}

/** fill_element(), table 4.11. */
function readFill(reader) {
  let count = reader.read(4);
  if (count === 15) count += reader.read(8) - 1;
  if (!reader.ok) return false;
  // Whatever the payload turns out to be, and SBR data is the usual one, it
  // occupies exactly the counted bytes. Reading it would say nothing more about
  // where the frame ends.
  reader.skip(count * 8);
  return reader.ok;
}

/** True for the object types this parser reads. */
function isSupportedObjectType(objectType) {
  return objectType === 2 || objectType === 4;
}

/** GetAudioObjectType(), five bits with an escape into six more. */
function readObjectType(reader) {
  const value = reader.read(5);
  if (value === 31) return 32 + reader.read(6);
  return value;
}

/**
 * Parse the AudioSpecificConfig, the bytes an esds box carries.
 *
 * Returns `{ objectType, sampleRate, sampleRateIndex, channelConfig,
 * frameLength }`, where frameLength is 1024 or 960 samples, or null if the
 * bytes cannot be read as a configuration at all.
 *
 * `sampleRate` is the rate the frames are coded at. When a configuration
 * signals SBR the output rate is twice that, which changes nothing about where
 * the frames are, so it is the coded rate that is reported here.
 */
export function parseAudioSpecificConfig(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 2) return null;
  const reader = new BitReader(bytes);

  let objectType = readObjectType(reader);
  const sampleRateIndex = reader.read(4);
  const sampleRate = sampleRateIndex === 0xf ? reader.read(24) : SAMPLE_RATES[sampleRateIndex];
  const channelConfig = reader.read(4);

  // Object types 5 and 29 are SBR, and SBR with parametric stereo, signalled up
  // front. What follows is the rate the extension outputs at and then the object
  // type that actually codes the frames, which is the one to carry on with.
  // The rate read above stays: subclause 1.6.3.4 has it as the rate of the audio
  // object itself, and the extension is the one that doubles it on the way out.
  if (objectType === 5 || objectType === 29) {
    if (reader.read(4) === 0xf) reader.skip(24);
    objectType = readObjectType(reader);
    if (objectType === 22) reader.skip(4); // extensionChannelConfiguration
  }

  let frameLength = 1024;
  // GASpecificConfig, table 4.1, for the general audio object types.
  const generalAudio = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].indexOf(objectType) >= 0;
  if (generalAudio) {
    frameLength = reader.read1() ? 960 : 1024;
    if (reader.read1()) reader.skip(14); // coreCoderDelay
    reader.read1(); // extensionFlag, and what follows it changes no frame length
  }
  if (!reader.ok) return null;
  if (!sampleRate) return null;

  return { objectType, sampleRate, sampleRateIndex, channelConfig, frameLength };
}

/**
 * Length in bytes of the AAC frame that starts at `offset`, or 0.
 *
 * Zero means the bytes there are not a frame of this stream. That covers a
 * truncated buffer, an offset past the end, an object type this parser does not
 * read, a sampling frequency written out in full rather than by index, since
 * the band tables are indexed by the standard's own list of rates, and bits
 * that simply do not parse. It never throws.
 */
export function frameLength(bytes, offset, config) {
  if (!bytes || typeof bytes.length !== 'number') return 0;
  if (!config || !isSupportedObjectType(config.objectType)) return 0;
  if (!(config.sampleRateIndex >= 0) || config.sampleRateIndex > 12) return 0;
  if (config.frameLength !== 1024 && config.frameLength !== 960) return 0;
  if (!(offset >= 0) || offset >= bytes.length) return 0;

  try {
    const reader = new BitReader(bytes);
    reader.seek(offset * 8);
    let channels = 0;
    // Coupling channels are not heard, and they still have a buffer of their
    // own, so the size limit counts them and the channel total does not.
    let buffers = 0;
    let elements = 0;

    for (;;) {
      const id = reader.read(3);
      if (!reader.ok) return 0;
      if (id === ID_END) break;
      elements += 1;
      if (elements > MAX_ELEMENTS) return 0;

      let ok = false;
      switch (id) {
        case ID_SCE:
        case ID_LFE:
          ok = readSingleChannel(reader, config);
          channels += 1;
          buffers += 1;
          break;
        case ID_CPE:
          ok = readChannelPair(reader, config);
          channels += 2;
          buffers += 2;
          break;
        case ID_CCE:
          ok = readCouplingChannel(reader, config);
          buffers += 1;
          break;
        case ID_DSE:
          ok = readDataStream(reader);
          break;
        case ID_PCE:
          ok = readProgramConfig(reader);
          break;
        case ID_FIL:
          ok = readFill(reader);
          break;
        default:
          ok = false;
      }
      if (!ok) return 0;
    }

    reader.align();
    if (!reader.ok) return 0;

    // A block with no channel in it decodes to no sound. It is legal syntax and
    // it is not a frame, and letting it count would have three bits of any
    // rubbish read as a one byte frame.
    if (channels < 1) return 0;
    // A stream that says how many channels it has says it about every frame.
    if (config.channelConfig >= 1 && config.channelConfig <= 7
        && channels !== config.channelConfig) return 0;

    const size = reader.pos / 8 - offset;
    if (size < 1 || size * 8 > buffers * MAX_BITS_PER_CHANNEL) return 0;
    return size;
  } catch {
    // The reader is total and the tables are fixed, so nothing here should be
    // able to raise. The contract is that this returns a number, and that
    // matters more than finding out.
    return 0;
  }
}

/**
 * Split a run of frames stored back to back.
 *
 * Returns `{ frames: [{ offset, size }], skipped }`, where `skipped` counts the
 * bytes that could not be read as any frame. A frame that fails costs one byte:
 * the search steps forward and tries again, which is how a run of damage is
 * crossed rather than given in to.
 */
/* How far to keep trying to pick the sound back up after damage. Past this,
 * what is being walked is not damaged sound: it is the tail of a file after
 * the last frame, or a stretch that was overwritten wholesale. Reading twelve
 * megabytes of that one byte at a time is minutes of work for nothing. */
const MAX_RESYNC_RUN = 256 * 1024;

export function segment(bytes, config) {
  const frames = [];
  let skipped = 0;
  if (!bytes || typeof bytes.length !== 'number') return { frames, skipped };

  let position = 0;
  let sinceAFrame = 0;
  while (position < bytes.length) {
    const size = frameLength(bytes, position, config);
    if (size > 0) {
      frames.push({ offset: position, size });
      position += size;
      sinceAFrame = 0;
    } else {
      skipped += 1;
      position += 1;
      if (++sinceAFrame > MAX_RESYNC_RUN) {
        skipped += bytes.length - position;
        break;
      }
    }
  }
  return { frames, skipped };
}
