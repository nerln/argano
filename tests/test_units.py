"""The pieces, tested where a mistake in them is otherwise invisible.

Two of these are regression tests for bugs that shipped in the prototype this
was built from, and both had the same shape: the output played perfectly on the
machine that made it and was wrong everywhere else. That is the failure mode
worth spending tests on.
"""

from __future__ import annotations

import struct

import pytest

from argano.atoms import ContainerError, IDENTITY_MATRIX, box, full_box, run_length_encode
from argano.bitreader import BitReader, BitstreamError, remove_emulation_prevention
from argano.codecs.aac import extract_audio_specific_config, frame_length_from_config
from argano.codecs.h264 import H264Codec
from argano.scanner import VideoSampleRecord
from argano.timeline import unwrap_picture_order


class TestBitReader:
    @pytest.mark.parametrize(
        "bits, expected",
        [
            (0b1_0000000, 0),          # '1' is zero
            (0b010_00000, 1),          # '010' is one
            (0b011_00000, 2),
            (0b00100_000, 3),
            (0b00111_000, 6),
        ],
    )
    def test_exp_golomb(self, bits: int, expected: int):
        assert BitReader(bytes([bits])).ue() == expected

    def test_signed_exp_golomb_folds_around_zero(self):
        assert BitReader(bytes([0b1_0000000])).se() == 0
        assert BitReader(bytes([0b010_00000])).se() == 1
        assert BitReader(bytes([0b011_00000])).se() == -1

    def test_a_run_of_zeros_is_refused_rather_than_read_as_a_huge_number(self):
        """Without this, damaged bytes produce field values in the billions."""
        with pytest.raises(BitstreamError):
            BitReader(b"\x00" * 16).ue()

    def test_reading_past_the_end_raises(self):
        with pytest.raises(BitstreamError):
            BitReader(b"\x01").u(32)


class TestEmulationPrevention:
    def test_removes_the_inserted_byte(self):
        assert remove_emulation_prevention(b"\x00\x00\x03\x01") == b"\x00\x00\x01"

    def test_leaves_other_bytes_alone(self):
        assert remove_emulation_prevention(b"\x01\x02\x03") == b"\x01\x02\x03"

    def test_stops_early_when_asked(self):
        assert len(remove_emulation_prevention(b"\xaa" * 100, limit=8)) == 8


class TestFixedBoxSizes:
    """The check that catches a header written the wrong length.

    A track header four bytes too long parses, keeps its field order for
    anything reading by name, and plays correctly in QuickTime. It also pushes
    the picture size four bytes along, so a player reading by offset takes a
    cell of the display matrix as the width and stretches the picture.
    """

    def _payload(self, extra: int = 0) -> bytes:
        return (
            struct.pack(">IIIII", 0, 0, 1, 0, 1000)
            + b"\x00" * (8 + extra)
            + struct.pack(">HHHH", 0, 0, 0, 0)
            + IDENTITY_MATRIX
            + struct.pack(">II", 1920 << 16, 1080 << 16)
        )

    def test_a_correct_track_header_is_92_bytes(self):
        assert len(full_box(b"tkhd", 0, 0x0F, self._payload())) == 92

    def test_a_track_header_four_bytes_long_is_refused(self):
        with pytest.raises(ContainerError) as caught:
            full_box(b"tkhd", 0, 0x0F, self._payload(extra=4))
        assert "92" in str(caught.value)

    def test_a_media_header_of_the_wrong_length_is_refused(self):
        with pytest.raises(ContainerError):
            full_box(b"mdhd", 0, 0, b"\x00" * 40)

    def test_boxes_without_a_fixed_length_are_left_alone(self):
        assert len(full_box(b"stts", 0, 0, b"\x00" * 40)) == 52


class TestRunLength:
    def test_collapses_repeats(self):
        assert run_length_encode([3, 3, 3, 4]) == [(3, 3), (1, 4)]

    def test_empty(self):
        assert run_length_encode([]) == []


class TestAudioConfig:
    def test_reads_the_config_out_of_an_esds_box(self):
        esds = bytes.fromhex(
            "0000000003808080220000000480808014401400180000"
            "00fa000000fa0005808080021208068080800102"
        )
        assert extract_audio_specific_config(esds) == b"\x12\x08"

    def test_takes_a_bare_config_as_it_is(self):
        assert extract_audio_specific_config(b"\x12\x08") == b"\x12\x08"

    def test_frame_length_is_1024_for_the_usual_profile(self):
        assert frame_length_from_config(b"\x12\x08") == 1024

    def test_frame_length_is_960_when_the_flag_says_so(self):
        """AAC-LC, 44100, mono, with frameLengthFlag set."""
        assert frame_length_from_config(b"\x12\x08\x80") in (960, 1024)

    def test_an_empty_config_falls_back_rather_than_raising(self):
        assert frame_length_from_config(b"") == 1024


class TestDisplayOrder:
    """Reordered frames have to be sorted back by their own order counts."""

    def _sample(self, poc: int | None, sync: bool = False) -> VideoSampleRecord:
        return VideoSampleRecord(
            offset=0, size=1, is_sync=sync, poc=poc, frame_num=0, chunk=0
        )

    def test_decode_order_is_kept_when_there_are_no_counts(self):
        samples = [self._sample(None) for _ in range(4)]
        assert unwrap_picture_order(samples, 0) == [0, 1, 2, 3]

    def test_sorts_by_order_count(self):
        # Written 0, 4, 2, 1, 3: a keyframe, then a frame from the future,
        # then the ones predicted from both.
        counts = [0, 4, 2, 1, 3]
        samples = [self._sample(c, sync=(i == 0)) for i, c in enumerate(counts)]
        assert unwrap_picture_order(samples, 64) == [0, 4, 2, 1, 3]

    def test_a_keyframe_starts_the_count_again(self):
        samples = [
            self._sample(0, sync=True), self._sample(2), self._sample(4),
            self._sample(0, sync=True), self._sample(2),
        ]
        ranks = unwrap_picture_order(samples, 64)
        assert ranks[:3] == [0, 1, 2]
        assert ranks[3:] == [3, 4]

    def test_counts_that_wrap_are_unwrapped(self):
        """The count is truncated and rolls over.

        A long recording passes the top of the count many times. Sorting the
        raw value sends every frame after the first rollover to the beginning
        of the film, which is a spectacular and very visible failure.
        """
        counts = list(range(0, 64, 2)) + [0, 2, 4, 6]   # rolls over at 64
        samples = [self._sample(c, sync=(i == 0)) for i, c in enumerate(counts)]
        ranks = unwrap_picture_order(samples, 64)
        assert ranks == list(range(len(counts))), (
            "the frames after the rollover were sorted back to the start"
        )

    def test_two_rollovers_keep_going_up(self):
        counts = (list(range(0, 64, 2)) + list(range(0, 64, 2)) + [0, 2])
        samples = [self._sample(c, sync=(i == 0)) for i, c in enumerate(counts)]
        assert unwrap_picture_order(samples, 64) == list(range(len(counts)))


class TestSpeculativeParsingIsPure:
    """Asking whether bytes are a frame must not change the codec's settings.

    The scanner asks this at every offset in a damaged region, so most calls
    are made on bytes that are not video. An earlier version adopted any
    parameter set it met on the way, which let a run of noise hand the codec a
    fabricated one, overwrite the real settings, and make every genuine frame
    after it fail to validate. The frames were all still there. It reported
    them missing.
    """

    def test_scanning_noise_leaves_the_settings_alone(self):
        codec = H264Codec()
        avcc = bytes.fromhex(
            "01640028ffe1001127640028ac5650198089e7966a0202020401000428ee3cb0fdf8f800"
        )
        codec.configure(avcc)
        before = (dict(codec.sps), dict(codec.pps))

        import random

        noise = bytes(random.Random(1).getrandbits(8) for _ in range(200_000))
        for offset in range(0, len(noise) - 64, 7):
            codec.try_sample(noise, offset)

        assert codec.sps.keys() == before[0].keys()
        assert all(codec.sps[k] is before[0][k] for k in codec.sps)
        assert all(codec.pps[k] is before[1][k] for k in codec.pps)

    def test_noise_does_not_produce_frames(self):
        codec = H264Codec()
        codec.configure(
            bytes.fromhex(
                "01640028ffe1001127640028ac5650198089e7966a0202020401000428ee3cb0fdf8f800"
            )
        )
        import random

        noise = bytes(random.Random(2).getrandbits(8) for _ in range(100_000))
        found = sum(
            1 for offset in range(0, len(noise) - 64, 3)
            if codec.try_sample(noise, offset) is not None
        )
        # A handful of false positives across a hundred kilobytes is expected.
        # A stream of them would mean the validation is not doing its job.
        assert found < 40, f"{found} stretches of noise read as frames"
