"""End to end: break a file in a known way, repair it, check what came back.

The assertion that matters most is not that the output plays. It is that the
media bytes in the output are the media bytes from the input, unchanged. A
repair that re-encodes can always produce something playable, and it has cost
the user quality to do it. This one has to be able to claim it did not.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from argano import RepairOptions, diagnose, repair
from argano.pipeline import RepairError

from .conftest import decode_errors, needs_ffmpeg, probe

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.damage import inject_garbage, strip_index, top_level_boxes  # noqa: E402

pytestmark = needs_ffmpeg


def media_bytes(path: Path) -> bytes:
    data = path.read_bytes()
    for type_, offset, size in top_level_boxes(data):
        if type_ == b"mdat":
            header = 16 if data[offset : offset + 4] == b"\x00\x00\x00\x01" else 8
            return data[offset + header : offset + size]
    raise AssertionError(f"{path} has no media")


def break_file(source: Path, destination: Path) -> Path:
    destination.write_bytes(strip_index(source.read_bytes()))
    return destination


class TestUnfinalised:
    """The recorder stopped and never wrote the index. The common accident."""

    def test_recovers_every_frame(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        out = tmp_path / "fixed.mov"
        result = repair(broken, RepairOptions(output=out, reference=h264_aac))

        original = probe(h264_aac)
        fixed = probe(out)
        assert result.video_frames == original["video"]["frames"]
        assert fixed["video"]["frames"] == original["video"]["frames"]
        assert fixed["video"]["width"] == original["video"]["width"]
        assert fixed["video"]["height"] == original["video"]["height"]
        assert not result.scan.damage

    def test_media_is_not_re_encoded(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        out = tmp_path / "fixed.mov"
        repair(broken, RepairOptions(output=out, reference=h264_aac))
        assert media_bytes(out) == media_bytes(broken)

    def test_output_decodes_without_complaint(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        out = tmp_path / "fixed.mov"
        repair(broken, RepairOptions(output=out, reference=h264_aac))
        assert decode_errors(out) == []

    def test_duration_is_within_a_frame_of_the_original(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        out = tmp_path / "fixed.mov"
        repair(broken, RepairOptions(output=out, reference=h264_aac))
        assert abs(probe(out)["duration"] - probe(h264_aac)["duration"]) < 0.15

    def test_audio_frame_count_is_exact(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        out = tmp_path / "fixed.mov"
        result = repair(broken, RepairOptions(output=out, reference=h264_aac))
        if result.audio_frames == 0:
            pytest.skip("libfaad is not installed, so the sound was left out")
        assert result.audio_frames == probe(h264_aac)["audio"]["frames"]

    def test_stereo_at_a_different_rate(self, h264_aac_stereo: Path, tmp_path: Path):
        """Nothing may be hardcoded to one channel count or one sample rate."""
        broken = break_file(h264_aac_stereo, tmp_path / "broken.mp4")
        out = tmp_path / "fixed.mp4"
        result = repair(broken, RepairOptions(output=out, reference=h264_aac_stereo))
        assert result.video_frames == probe(h264_aac_stereo)["video"]["frames"]
        assert decode_errors(out) == []


class TestNoAudio:
    """With no sound there is no clock to follow, so a rate has to be given."""

    def test_repairs_at_a_stated_frame_rate(self, h264_silent: Path, tmp_path: Path):
        broken = break_file(h264_silent, tmp_path / "broken.mp4")
        out = tmp_path / "fixed.mp4"
        result = repair(
            broken, RepairOptions(output=out, reference=h264_silent, fps=25.0)
        )
        assert result.video_frames == probe(h264_silent)["video"]["frames"]
        assert abs(probe(out)["duration"] - probe(h264_silent)["duration"]) < 0.2
        assert "25" in result.timing_model


class TestDamagedMedia:
    """Runs of noise written over the media, as a failing card produces."""

    def test_keeps_going_past_the_damage(self, h264_aac: Path, tmp_path: Path):
        data = inject_garbage(strip_index(h264_aac.read_bytes()), runs=2, length=4000, seed=3)
        broken = tmp_path / "broken.mov"
        broken.write_bytes(data)
        out = tmp_path / "fixed.mov"
        result = repair(broken, RepairOptions(output=out, reference=h264_aac))

        original_frames = probe(h264_aac)["video"]["frames"]
        # Some frames sit under the noise and are gone. Most are not.
        assert result.video_frames > original_frames * 0.7
        assert result.video_frames <= original_frames

    def test_reports_where_the_damage_was(self, h264_aac: Path, tmp_path: Path):
        data = inject_garbage(strip_index(h264_aac.read_bytes()), runs=2, length=4000, seed=5)
        broken = tmp_path / "broken.mov"
        broken.write_bytes(data)
        out = tmp_path / "fixed.mov"
        result = repair(broken, RepairOptions(output=out, reference=h264_aac))
        assert result.scan.damage, "damage was silently absorbed instead of reported"
        assert result.scan.damaged_bytes > 0

    def test_result_still_decodes(self, h264_aac: Path, tmp_path: Path):
        data = inject_garbage(strip_index(h264_aac.read_bytes()), runs=1, length=6000, seed=11)
        broken = tmp_path / "broken.mov"
        broken.write_bytes(data)
        out = tmp_path / "fixed.mov"
        repair(broken, RepairOptions(output=out, reference=h264_aac))
        # A frame or two under the noise may upset the decoder. A file that
        # cannot be read through at all would be a failure.
        assert len(decode_errors(out)) < 40


class TestTruncated:
    """The file simply stops, as an interrupted copy does."""

    def test_recovers_what_is_there(self, h264_aac: Path, tmp_path: Path):
        data = strip_index(h264_aac.read_bytes())
        broken = tmp_path / "broken.mov"
        broken.write_bytes(data[: int(len(data) * 0.55)])
        out = tmp_path / "fixed.mov"
        result = repair(broken, RepairOptions(output=out, reference=h264_aac))
        original_frames = probe(h264_aac)["video"]["frames"]
        assert 0 < result.video_frames < original_frames
        assert decode_errors(out) == [] or len(decode_errors(out)) < 10


class TestSelfDescribing:
    """A file that still has a readable index does not need a second file."""

    def test_no_reference_needed_when_the_index_survives(self, h264_aac: Path, tmp_path: Path):
        source = tmp_path / "copy.mov"
        source.write_bytes(h264_aac.read_bytes())
        out = tmp_path / "fixed.mov"
        result = repair(source, RepairOptions(output=out))
        assert result.video_frames == probe(h264_aac)["video"]["frames"]
        assert "own" in result.profile_source

    def test_says_so_when_it_cannot_describe_itself(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        with pytest.raises(RepairError) as caught:
            repair(broken, RepairOptions(output=tmp_path / "fixed.mov"))
        assert "reference" in str(caught.value).lower()


class TestHevc:
    def test_h265_round_trip(self, hevc_aac, tmp_path: Path):
        if hevc_aac is None:
            pytest.skip("no H.265 encoder available to build the sample")
        broken = break_file(hevc_aac, tmp_path / "broken.mp4")
        out = tmp_path / "fixed.mp4"
        result = repair(broken, RepairOptions(output=out, reference=hevc_aac))
        original = probe(hevc_aac)
        assert result.video_frames == original["video"]["frames"]
        assert media_bytes(out) == media_bytes(broken)
        assert decode_errors(out) == []


class TestFaststart:
    def test_index_can_be_written_first(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        out = tmp_path / "fixed.mov"
        repair(broken, RepairOptions(output=out, reference=h264_aac, faststart=True))
        names = [type_.decode() for type_, _, _ in top_level_boxes(out.read_bytes())]
        assert names.index("moov") < names.index("mdat")
        assert decode_errors(out) == []


class TestDiagnosis:
    def test_names_the_accident(self, h264_aac: Path, tmp_path: Path):
        broken = break_file(h264_aac, tmp_path / "broken.mov")
        result = diagnose(broken)
        assert result.unfinalised
        assert result.needs_reference
        assert result.media_size > 0
        assert "final" in result.verdict

    def test_recognises_a_healthy_file(self, h264_aac: Path):
        result = diagnose(h264_aac)
        assert result.index_readable
        assert not result.needs_reference
