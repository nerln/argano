"""H.264, as stored inside MP4.

In an MP4 the stream is not the Annex B format with 00 00 01 start codes. Each
NAL unit is written with its length in front, one to four bytes of it, and the
length of that length is recorded once in the `avcC` configuration record. So
walking the stream is a matter of reading a length, stepping over that many
bytes, and reading the next one.

The trap is that this walk cannot tell you it has gone wrong. Four bytes of
compressed picture data read as a length give a number in the plausible range
often enough that a scanner following lengths alone will step into the middle
of a frame and keep going, producing samples that are pure noise. That is the
failure everyone hits on a file whose index is gone.

The way out is to stop trusting the length and read the slice header behind it.
`first_mb_in_slice`, `slice_type` and `pic_parameter_set_id` are Exp-Golomb
coded, one after another, and they have to land on values that the sequence
parameter set agrees with. Three of those in a row on random data is rare, and
a picture that does not start a picture is rejected on the spot.
"""

from __future__ import annotations

import struct

from ..bitreader import BitReader, BitstreamError, remove_emulation_prevention
from .base import VideoCodec, VideoSample

NAL_SLICE = 1
NAL_SLICE_IDR = 5
NAL_SEI = 6
NAL_SPS = 7
NAL_PPS = 8
NAL_AUD = 9

VCL_TYPES = frozenset({1, 2, 3, 4, 5})
# The types an encoder actually writes into an MP4 sample. Anything else is
# either a transport artefact or a coincidence.
KNOWN_TYPES = frozenset({1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20})
# Types that can only appear before the first picture of an access unit.
AU_PREFIX_TYPES = frozenset({6, 7, 8, 9, 13, 14, 15})

HIGH_PROFILES = frozenset({100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135})

# Slice headers are short. Reading 64 bytes past the NAL header is more than
# enough for every field this needs and keeps the emulation-prevention pass off
# the megabyte of picture data behind it.
HEADER_SCAN_BYTES = 64
# The largest a parameter set or SEI is allowed to be before it stops being
# believable. Real ones are tens of bytes.
MAX_PREFIX_NAL = 64 << 10
# A picture split into more pieces than this is not something a camera or a
# screen recorder writes. The bound matters because every extra piece accepted
# on bad bytes makes the sample longer.
MAX_SLICES_PER_PICTURE = 64
# Units that introduce a picture: parameter sets, access unit delimiters and
# supplemental information. Real ones come in ones and twos.
MAX_PREFIX_NALS = 8
MAX_PREFIX_BYTES = 128 << 10


class SequenceParameterSet:
    """The fields of an SPS that the slice header depends on."""

    def __init__(self, payload: bytes) -> None:
        rbsp = remove_emulation_prevention(payload[1:], limit=256)
        r = BitReader(rbsp)
        self.profile_idc = r.u(8)
        r.u(8)  # constraint flags and reserved bits
        self.level_idc = r.u(8)
        self.id = r.ue()

        self.chroma_format_idc = 1
        self.separate_colour_plane_flag = 0
        if self.profile_idc in HIGH_PROFILES:
            self.chroma_format_idc = r.ue()
            if self.chroma_format_idc == 3:
                self.separate_colour_plane_flag = r.flag()
            r.ue()  # bit_depth_luma_minus8
            r.ue()  # bit_depth_chroma_minus8
            r.flag()  # qpprime_y_zero_transform_bypass_flag
            if r.flag():  # seq_scaling_matrix_present_flag
                count = 8 if self.chroma_format_idc != 3 else 12
                for i in range(count):
                    if r.flag():
                        r.skip_scaling_list(16 if i < 6 else 64)

        self.log2_max_frame_num = r.ue() + 4
        self.pic_order_cnt_type = r.ue()
        self.log2_max_poc_lsb = 0
        self.delta_pic_order_always_zero_flag = 0
        if self.pic_order_cnt_type == 0:
            self.log2_max_poc_lsb = r.ue() + 4
        elif self.pic_order_cnt_type == 1:
            self.delta_pic_order_always_zero_flag = r.flag()
            r.se()  # offset_for_non_ref_pic
            r.se()  # offset_for_top_to_bottom_field
            for _ in range(r.ue()):
                r.se()

        r.ue()  # max_num_ref_frames
        r.flag()  # gaps_in_frame_num_value_allowed_flag
        width_mbs = r.ue() + 1
        height_map_units = r.ue() + 1
        self.frame_mbs_only_flag = r.flag()
        if not self.frame_mbs_only_flag:
            r.flag()  # mb_adaptive_frame_field_flag

        self.width = width_mbs * 16
        self.height = height_map_units * 16 * (2 - self.frame_mbs_only_flag)
        # How many macroblocks a picture has. A slice cannot start past the end
        # of the picture it belongs to, and that one bound is what stops a walk
        # from stringing together imaginary slices for fourteen megabytes.
        self.picture_macroblocks = width_mbs * height_map_units * (2 - self.frame_mbs_only_flag)

    @property
    def sample_ceiling(self) -> int:
        """The largest a single frame is allowed to be.

        Without a ceiling, four bytes of noise read as a length of nine
        megabytes and the walk accepts a frame that is not there, swallowing
        everything after it. The bound is taken from the reference when there
        is one. Failing that it comes from the picture itself: a compressed
        frame cannot be larger than the same picture uncompressed, and that is
        true of every encoder there is.
        """
        if self.max_sample_size:
            return self.max_sample_size
        sps = next(iter(self.sps.values()), None)
        if sps is not None and sps.width and sps.height:
            return max(1 << 20, sps.width * sps.height * 3)
        return self._max_nal

    @property
    def max_poc_lsb(self) -> int:
        return 1 << self.log2_max_poc_lsb


class PictureParameterSet:
    """The one PPS field a slice header needs before the order count."""

    def __init__(self, payload: bytes) -> None:
        rbsp = remove_emulation_prevention(payload[1:], limit=32)
        r = BitReader(rbsp)
        self.id = r.ue()
        self.sps_id = r.ue()
        r.flag()  # entropy_coding_mode_flag
        self.bottom_field_pic_order_in_frame_present_flag = r.flag()


class H264Codec(VideoCodec):
    name = "h264"
    fourcc = b"avc1"

    def __init__(self) -> None:
        self.nal_length_size = 4
        self.sps: dict[int, SequenceParameterSet] = {}
        self.pps: dict[int, PictureParameterSet] = {}
        self.max_slices = MAX_SLICES_PER_PICTURE
        self.max_sample_size = 0     # 0 means work it out from the picture size
        self._max_nal = 32 << 20

    # --- configuration ---

    @property
    def configured(self) -> bool:
        return bool(self.sps) and bool(self.pps)

    def configure(self, config: bytes) -> None:
        """Read an `avcC` record: the NAL length size and the parameter sets."""
        if len(config) < 7:
            raise ValueError("avcC record is too short to be one")
        self.nal_length_size = (config[4] & 0x03) + 1
        pos = 5
        count = config[pos] & 0x1F
        pos += 1
        for _ in range(count):
            length = struct.unpack(">H", config[pos : pos + 2])[0]
            pos += 2
            self.add_parameter_set(config[pos : pos + length])
            pos += length
        if pos < len(config):
            count = config[pos]
            pos += 1
            for _ in range(count):
                length = struct.unpack(">H", config[pos : pos + 2])[0]
                pos += 2
                self.add_parameter_set(config[pos : pos + length])
                pos += length

    def add_parameter_set(self, nal: bytes) -> None:
        """Take an SPS or PPS, wherever it was found.

        Some encoders leave these in the stream as well as in `avcC`. When a
        reference file is not available that in-band copy is the only way to
        learn how to read the slice headers, so both routes end up here.
        """
        if not nal:
            return
        nal_type = nal[0] & 0x1F
        try:
            if nal_type == NAL_SPS:
                sps = SequenceParameterSet(nal)
                self.sps[sps.id] = sps
            elif nal_type == NAL_PPS:
                pps = PictureParameterSet(nal)
                self.pps[pps.id] = pps
        except (BitstreamError, IndexError, struct.error):
            pass

    def build_config(self) -> bytes:
        """Write an `avcC` back out from what we hold."""
        sps = next(iter(self.sps.values()))
        raise NotImplementedError("configuration is copied from the source, not rebuilt")

    @property
    def sample_ceiling(self) -> int:
        """The largest a single frame is allowed to be.

        Without a ceiling, four bytes of noise read as a length of nine
        megabytes and the walk accepts a frame that is not there, swallowing
        everything after it. The bound is taken from the reference when there
        is one. Failing that it comes from the picture itself: a compressed
        frame cannot be larger than the same picture uncompressed, and that is
        true of every encoder there is.
        """
        if self.max_sample_size:
            return self.max_sample_size
        sps = next(iter(self.sps.values()), None)
        if sps is not None and sps.width and sps.height:
            return max(1 << 20, sps.width * sps.height * 3)
        return self._max_nal

    @property
    def max_poc_lsb(self) -> int:
        sps = next(iter(self.sps.values()), None)
        return sps.max_poc_lsb if sps else 0

    @property
    def poc_type(self) -> int:
        sps = next(iter(self.sps.values()), None)
        return sps.pic_order_cnt_type if sps else 2

    # --- scanning ---

    def try_sample(
        self, data: bytes, offset: int, limit: int | None = None
    ) -> VideoSample | None:
        """Read one access unit at `offset`, or decide there is not one.

        An access unit is everything belonging to a single picture: any
        parameter sets and SEI in front of it, then one or more slices. It
        ends where the next picture's first slice begins.

        This asks a question and changes nothing, which matters more than it
        sounds. The scanner calls it at every candidate offset in a damaged
        region, so most calls are made on bytes that are not video at all. An
        earlier version took any parameter set it met along the way, which
        meant a run of noise could hand the codec a fabricated one, overwrite
        the real settings, and quietly make every genuine frame after it fail
        to validate. Parameter sets are gathered in one deliberate pass
        instead, where a set has to turn up more than once to be believed.
        """
        n = len(data) if limit is None else min(len(data), limit)
        pos = offset
        ls = self.nal_length_size
        seen_vcl = False
        first: tuple[int, int, bool, int | None] | None = None
        first_frame_num: int | None = None
        slices = 0
        last_first_mb = -1
        prefix_nals = 0
        prefix_bytes = 0

        while pos + ls + 1 <= n:
            length = int.from_bytes(data[pos : pos + ls], "big")
            if length < 1 or length > self.sample_ceiling:
                break
            end = pos + ls + length
            if end > n:
                break

            header = data[pos + ls]
            if header & 0x80:  # forbidden_zero_bit
                break
            nal_type = header & 0x1F
            nal_ref_idc = (header >> 5) & 0x03
            if nal_type not in KNOWN_TYPES:
                break

            if not seen_vcl and nal_type not in VCL_TYPES:
                # Only the small things that introduce a picture may come
                # first, and they are small: parameter sets and SEI are a few
                # dozen bytes. A "parameter set" a megabyte long is a length
                # read out of something that is not video.
                if nal_type not in AU_PREFIX_TYPES or length > MAX_PREFIX_NAL:
                    break
                prefix_nals += 1
                prefix_bytes += length
                # A picture is introduced by a handful of small units.
                # Without a ceiling on how many, a run of noise can
                # supply a hundred of them and the sample comes out
                # megabytes long with no picture in it at all.
                if prefix_nals > MAX_PREFIX_NALS or prefix_bytes > MAX_PREFIX_BYTES:
                    return None

            if nal_type in VCL_TYPES:
                parsed = self._read_slice_header(
                    data[pos + ls : min(end, pos + ls + HEADER_SCAN_BYTES)], nal_type
                )
                if parsed is None:
                    break
                first_mb, slice_type, poc, frame_num = parsed
                if seen_vcl:
                    if first_mb == 0:
                        break          # the next picture starts here
                    # Later pieces of one picture have to agree with the first
                    # piece about which picture it is, and each has to start
                    # after the one before. Without that, any bytes that happen
                    # to read as a slice header keep extending the sample, and
                    # a run of sound after the last real slice can add twenty
                    # megabytes to a frame that is twenty-six kilobytes long.
                    if first_mb <= last_first_mb:
                        break
                    if frame_num != first_frame_num or poc != first[3]:
                        break
                    slices += 1
                    if slices > self.max_slices:
                        break
                elif first_mb != 0:
                    return None        # a sample cannot begin mid-picture
                last_first_mb = first_mb
                if not seen_vcl:
                    first = (nal_type, slice_type, nal_ref_idc > 0, poc)
                    first_frame_num = frame_num
                seen_vcl = True
            elif seen_vcl:
                # The picture is complete. Anything that is not another slice
                # of it ends the sample here.
                #
                # Being strict about this is what stops a runaway. The bytes
                # after the last slice are usually sound, and sound read as a
                # NAL header occasionally yields a plausible type and a length
                # of several megabytes. Accepting that once swallows hundreds
                # of frames into a single sample, and the scan then reports
                # them as damage.
                break

            pos = end

        if not seen_vcl or first is None:
            return None
        nal_type, slice_type, is_ref, poc = first
        return VideoSample(
            size=pos - offset,
            is_sync=(nal_type == NAL_SLICE_IDR),
            poc=poc,
            frame_num=first_frame_num,
            is_reference=is_ref,
        )

    def _read_slice_header(
        self, nal: bytes, nal_type: int
    ) -> tuple[int, int, int | None, int | None] | None:
        """`(first_mb_in_slice, slice_type, poc_lsb, frame_num)`, or None if it is not a slice.

        Every rejection here is a position the scanner will not walk into. The
        checks are deliberately the cheap structural ones: a slice type above 9
        does not exist, and a PPS id naming a set the file never declared means
        this is not a slice header.
        """
        if len(nal) < 2:
            return None
        try:
            rbsp = remove_emulation_prevention(nal[1:], limit=HEADER_SCAN_BYTES)
            r = BitReader(rbsp)
            first_mb = r.ue()
            slice_type = r.ue()
            if slice_type > 9:
                return None
            pps_id = r.ue()
            pps = self.pps.get(pps_id)
            if pps is None:
                return None
            sps = self.sps.get(pps.sps_id)
            if sps is None:
                return None
            if first_mb >= sps.picture_macroblocks:
                return None

            if sps.separate_colour_plane_flag:
                r.u(2)
            frame_num = r.u(sps.log2_max_frame_num)

            field_pic = 0
            if not sps.frame_mbs_only_flag:
                field_pic = r.flag()
                if field_pic:
                    r.flag()  # bottom_field_flag

            if nal_type == NAL_SLICE_IDR:
                idr_pic_id = r.ue()
                if idr_pic_id > 65535:
                    return None

            poc: int | None = None
            if sps.pic_order_cnt_type == 0:
                poc = r.u(sps.log2_max_poc_lsb)
                if pps.bottom_field_pic_order_in_frame_present_flag and not field_pic:
                    r.se()
            return first_mb, slice_type, poc, frame_num
        except (BitstreamError, IndexError):
            return None
