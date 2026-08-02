"""H.265, which is what a modern phone records by default.

The shape is the same as H.264: length-prefixed NAL units, a configuration
record that says how long the lengths are, and slice headers that can be read
to tell a real picture from a coincidence. The details all differ. The NAL
header is two bytes instead of one, the picture type lives in six bits rather
than five, and whether a slice starts a picture is a single flag at the top of
the header rather than a counter that has to be compared against zero.

The one piece of real work is `profile_tier_level`, a variable-length block
near the top of the sequence parameter set that has to be stepped over exactly
to reach the fields behind it. Get its length wrong and every number after it
is read from the wrong bit.
"""

from __future__ import annotations

import struct

from ..bitreader import BitReader, BitstreamError, remove_emulation_prevention
from .base import VideoCodec, VideoSample

NAL_VPS = 32
NAL_SPS = 33
NAL_PPS = 34
NAL_AUD = 35
NAL_EOS = 36
NAL_EOB = 37
NAL_FD = 38
NAL_PREFIX_SEI = 39
NAL_SUFFIX_SEI = 40

IDR_W_RADL = 19
IDR_N_LP = 20

VCL_TYPES = frozenset(range(0, 32))
IRAP_TYPES = frozenset(range(16, 24))     # decodable with nothing before them
KNOWN_TYPES = frozenset(range(0, 42))
AU_PREFIX_TYPES = frozenset({NAL_VPS, NAL_SPS, NAL_PPS, NAL_AUD, NAL_PREFIX_SEI})

HEADER_SCAN_BYTES = 64
MAX_PREFIX_NAL = 64 << 10


def _skip_profile_tier_level(r: BitReader, max_sub_layers_minus1: int) -> None:
    """Step over profile_tier_level, whose length depends on its own contents."""
    r.u(2)   # general_profile_space
    r.u(1)   # general_tier_flag
    r.u(5)   # general_profile_idc
    r.u(32)  # general_profile_compatibility_flag
    r.u(32)  # constraint flags, first half
    r.u(16)  # constraint flags, second half
    r.u(8)   # general_level_idc

    profile_present = []
    level_present = []
    for _ in range(max_sub_layers_minus1):
        profile_present.append(r.u(1))
        level_present.append(r.u(1))
    if max_sub_layers_minus1 > 0:
        for _ in range(max_sub_layers_minus1, 8):
            r.u(2)
    for i in range(max_sub_layers_minus1):
        if profile_present[i]:
            r.u(32)
            r.u(32)
            r.u(24)
        if level_present[i]:
            r.u(8)


class HevcSps:
    def __init__(self, payload: bytes) -> None:
        rbsp = remove_emulation_prevention(payload[2:], limit=256)
        r = BitReader(rbsp)
        r.u(4)  # sps_video_parameter_set_id
        max_sub_layers_minus1 = r.u(3)
        r.u(1)  # sps_temporal_id_nesting_flag
        _skip_profile_tier_level(r, max_sub_layers_minus1)
        self.id = r.ue()
        self.chroma_format_idc = r.ue()
        self.separate_colour_plane_flag = 0
        if self.chroma_format_idc == 3:
            self.separate_colour_plane_flag = r.u(1)
        self.width = r.ue()
        self.height = r.ue()
        if r.u(1):  # conformance_window_flag
            r.ue(); r.ue(); r.ue(); r.ue()
        r.ue()  # bit_depth_luma_minus8
        r.ue()  # bit_depth_chroma_minus8
        self.log2_max_poc_lsb = r.ue() + 4
        if self.log2_max_poc_lsb > 16:
            raise BitstreamError("log2_max_pic_order_cnt_lsb out of range")

    @property
    def max_poc_lsb(self) -> int:
        return 1 << self.log2_max_poc_lsb


class HevcPps:
    def __init__(self, payload: bytes) -> None:
        rbsp = remove_emulation_prevention(payload[2:], limit=32)
        r = BitReader(rbsp)
        self.id = r.ue()
        self.sps_id = r.ue()
        self.dependent_slice_segments_enabled_flag = r.u(1)
        self.output_flag_present_flag = r.u(1)
        self.num_extra_slice_header_bits = r.u(3)


class HevcCodec(VideoCodec):
    name = "hevc"
    fourcc = b"hvc1"

    def __init__(self) -> None:
        self.nal_length_size = 4
        self.sps: dict[int, HevcSps] = {}
        self.pps: dict[int, HevcPps] = {}
        self._max_nal = 64 << 20

    @property
    def configured(self) -> bool:
        return bool(self.sps) and bool(self.pps)

    def configure(self, config: bytes) -> None:
        """Read an `hvcC` record.

        Everything before the arrays is a fixed 22-byte block, so the length
        size and the array count are read straight out of it.
        """
        if len(config) < 23:
            raise ValueError("hvcC record is too short to be one")
        self.nal_length_size = (config[21] & 0x03) + 1
        num_arrays = config[22]
        pos = 23
        for _ in range(num_arrays):
            if pos + 3 > len(config):
                break
            count = struct.unpack(">H", config[pos + 1 : pos + 3])[0]
            pos += 3
            for _ in range(count):
                if pos + 2 > len(config):
                    break
                length = struct.unpack(">H", config[pos : pos + 2])[0]
                pos += 2
                self.add_parameter_set(config[pos : pos + length])
                pos += length

    def add_parameter_set(self, nal: bytes) -> None:
        if len(nal) < 3:
            return
        nal_type = (nal[0] >> 1) & 0x3F
        try:
            if nal_type == NAL_SPS:
                sps = HevcSps(nal)
                self.sps[sps.id] = sps
            elif nal_type == NAL_PPS:
                pps = HevcPps(nal)
                self.pps[pps.id] = pps
        except (BitstreamError, IndexError, struct.error):
            pass

    @property
    def max_poc_lsb(self) -> int:
        sps = next(iter(self.sps.values()), None)
        return sps.max_poc_lsb if sps else 0

    @property
    def poc_type(self) -> int:
        return 0  # H.265 has only the one order-count scheme

    def try_sample(
        self, data: bytes, offset: int, limit: int | None = None
    ) -> VideoSample | None:
        n = len(data) if limit is None else min(len(data), limit)
        pos = offset
        ls = self.nal_length_size
        seen_vcl = False
        first: tuple[int, bool, int | None] | None = None

        while pos + ls + 2 <= n:
            length = int.from_bytes(data[pos : pos + ls], "big")
            if length < 2 or length > self._max_nal:
                break
            end = pos + ls + length
            if end > n:
                break

            b0 = data[pos + ls]
            b1 = data[pos + ls + 1]
            if b0 & 0x80:
                break
            nal_type = (b0 >> 1) & 0x3F
            layer_id = ((b0 & 0x01) << 5) | (b1 >> 3)
            temporal_id_plus1 = b1 & 0x07
            if nal_type not in KNOWN_TYPES or temporal_id_plus1 == 0 or layer_id != 0:
                break

            if not seen_vcl and nal_type not in VCL_TYPES:
                if nal_type not in AU_PREFIX_TYPES or length > MAX_PREFIX_NAL:
                    break

            if nal_type in VCL_TYPES:
                parsed = self._read_slice_header(
                    data[pos + ls : min(end, pos + ls + HEADER_SCAN_BYTES)], nal_type
                )
                if parsed is None:
                    break
                first_in_pic, poc = parsed
                if seen_vcl:
                    if first_in_pic:
                        break
                elif not first_in_pic:
                    return None
                if not seen_vcl:
                    first = (nal_type, nal_type in IRAP_TYPES, poc)
                seen_vcl = True
            elif seen_vcl:
                break

            pos = end

        if not seen_vcl or first is None:
            return None
        nal_type, is_irap, poc = first
        return VideoSample(
            size=pos - offset,
            is_sync=is_irap,
            poc=poc,
            frame_num=None,
            is_reference=True,
        )

    def _read_slice_header(self, nal: bytes, nal_type: int) -> tuple[bool, int | None] | None:
        if len(nal) < 3:
            return None
        try:
            rbsp = remove_emulation_prevention(nal[2:], limit=HEADER_SCAN_BYTES)
            r = BitReader(rbsp)
            first_in_pic = bool(r.u(1))
            if nal_type in IRAP_TYPES:
                r.u(1)  # no_output_of_prior_pics_flag
            pps_id = r.ue()
            pps = self.pps.get(pps_id)
            if pps is None:
                return None
            sps = self.sps.get(pps.sps_id)
            if sps is None:
                return None

            if not first_in_pic:
                # Everything after this point in a dependent segment is
                # relative to the segment that opened the picture, and the
                # scanner only needs to know this is not a new picture.
                return False, None

            for _ in range(pps.num_extra_slice_header_bits):
                r.u(1)
            slice_type = r.ue()
            if slice_type > 2:
                return None
            if pps.output_flag_present_flag:
                r.u(1)
            if sps.separate_colour_plane_flag:
                r.u(2)

            poc: int | None = None
            if nal_type not in (IDR_W_RADL, IDR_N_LP):
                poc = r.u(sps.log2_max_poc_lsb)
            else:
                poc = 0
            return True, poc
        except (BitstreamError, IndexError):
            return None
