"""Checking the output before telling anyone it worked.

A repaired file that opens is not a repaired file that is right. The failure
worth designing against is the one that looks fine: an index whose numbers are
internally consistent and whose header has a field in the wrong place, which
QuickTime forgives because it reads fields by name and cross-checks them
against the codec, and which VLC, WhatsApp and YouTube do not, because they
read by offset. That file plays perfectly on the machine it was made on and is
broken everywhere else.

So the checks here read the file back the way a strict player would, from the
byte offsets, and compare what they find against three sources that should all
agree: the box lengths the format fixes, the picture size the encoder wrote
into its own parameter sets, and the sample tables' own internal arithmetic.
Anything that disagrees is reported before the user is told the job is done.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .atoms import FIXED_SIZES, Box, parse_boxes, read_box_payload


@dataclass
class Finding:
    level: str      # 'error' or 'warning'
    message: str


@dataclass
class VerifyReport:
    findings: list[Finding] = field(default_factory=list)
    video_frames: int = 0
    audio_frames: int = 0
    duration: float = 0.0
    width: int = 0
    height: int = 0
    decoded: bool = False
    decode_errors: int = 0

    @property
    def ok(self) -> bool:
        return not any(f.level == "error" for f in self.findings)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "warning"]

    def error(self, message: str) -> None:
        self.findings.append(Finding("error", message))

    def warn(self, message: str) -> None:
        self.findings.append(Finding("warning", message))


def verify_structure(path: Path, expected_size: tuple[int, int] | None = None) -> VerifyReport:
    """Read the index back by offset and check it against itself."""
    report = VerifyReport()
    size = path.stat().st_size

    with path.open("rb") as fh:
        boxes = parse_boxes(fh, 0, size)
        names = [b.name for b in boxes]
        if "moov" not in names:
            report.error("the output has no moov, so nothing will play it")
            return report
        if "mdat" not in names:
            report.error("the output has no mdat, so there is no media in it")
            return report

        mdat = next(b for b in boxes if b.type == b"mdat")
        moov = next(b for b in boxes if b.type == b"moov")

        for top in boxes:
            if top.truncated:
                report.error(f"the {top.name} box runs past the end of the file")

        _check_fixed_sizes(fh, moov, report)

        traks = moov.find_all("trak")
        if not traks:
            report.error("the index describes no tracks")
            return report

        for index, trak in enumerate(traks, start=1):
            _check_track(fh, trak, mdat, index, report, expected_size)

    return report


def _check_fixed_sizes(fh, moov: Box, report: VerifyReport) -> None:
    """Every box whose length the format fixes has to have that length.

    This is the check that catches a header written four bytes long, which is
    invisible to anything reading by name and shifts the picture size for
    anything reading by offset.
    """
    for node in moov.walk():
        matched = None
        for (type_, version), expected in FIXED_SIZES.items():
            if node.type != type_ or expected is None:
                continue
            payload = read_box_payload(fh, node)
            if not payload:
                continue
            if payload[0] != version:
                continue
            matched = (type_, version)
            if node.size != expected:
                report.error(
                    f"{node.name} version {version} is {node.size} bytes and must be "
                    f"{expected}. Every field after the mistake is read from the "
                    f"wrong offset, which is how a correct picture ends up stretched."
                )
            break


def _check_track(
    fh,
    trak: Box,
    mdat: Box,
    track_number: int,
    report: VerifyReport,
    expected_size: tuple[int, int] | None,
) -> None:
    label = f"track {track_number}"
    stbl = trak.find("mdia/minf/stbl")
    if stbl is None:
        report.error(f"{label} has no sample table")
        return

    sizes = _read_stsz(fh, stbl.find("stsz"))
    chunks = _read_chunk_offsets(fh, stbl)
    stsc = _read_stsc(fh, stbl.find("stsc"))
    durations_total, duration_count = _read_stts(fh, stbl.find("stts"))

    if sizes is None or chunks is None or stsc is None:
        report.error(f"{label} is missing one of the tables needed to find its samples")
        return

    if duration_count != len(sizes):
        report.error(
            f"{label} has {len(sizes)} samples but timings for {duration_count}"
        )

    counted = _samples_from_stsc(stsc, len(chunks))
    if counted != len(sizes):
        report.error(
            f"{label} says {len(sizes)} samples and its chunk map accounts for {counted}"
        )

    # Every sample has to land inside the media.
    media_start = mdat.payload_offset
    media_end = mdat.end
    index = 0
    for chunk_number, offset in enumerate(chunks, start=1):
        per_chunk = _samples_in_chunk(stsc, chunk_number)
        position = offset
        for _ in range(per_chunk):
            if index >= len(sizes):
                break
            position += sizes[index]
            index += 1
        if offset < media_start or position > media_end:
            report.error(
                f"{label} chunk {chunk_number} points outside the media, "
                f"at {offset} with the file's media running {media_start} to {media_end}"
            )
            break

    handler = _read_handler(fh, trak)
    if handler == "vide":
        _check_video_geometry(fh, trak, report, expected_size)


def _check_video_geometry(fh, trak: Box, report: VerifyReport, expected: tuple[int, int] | None) -> None:
    """The track header, the sample description and the encoder must agree."""
    tkhd = trak.find("tkhd")
    if tkhd is None:
        report.error("the video track has no header")
        return
    payload = read_box_payload(fh, tkhd)
    if payload[0] != 0 or len(payload) < 84:
        return
    width = struct.unpack(">I", payload[76:80])[0] >> 16
    height = struct.unpack(">I", payload[80:84])[0] >> 16

    stsd = trak.find("mdia/minf/stbl/stsd")
    coded: tuple[int, int] | None = None
    if stsd is not None:
        body = read_box_payload(fh, stsd)
        if len(body) >= 44:
            coded = struct.unpack(">HH", body[40:44])

    if width <= 0 or height <= 0:
        report.error(f"the video track header says the picture is {width} by {height}")
        return
    if coded and coded[0] > 0 and coded[1] > 0:
        ratio = (width / height) / (coded[0] / coded[1])
        if not 0.5 <= ratio <= 2.0:
            report.error(
                f"the track header says {width} by {height} and the sample "
                f"description says {coded[0]} by {coded[1]}. A player that trusts "
                f"the header will show the picture at the wrong shape."
            )
    if expected and (width, height) != expected:
        report.warn(
            f"the picture is {width} by {height} and the reference was "
            f"{expected[0]} by {expected[1]}"
        )


def _read_handler(fh, trak: Box) -> str:
    hdlr = trak.find("mdia/hdlr")
    if hdlr is None:
        return ""
    payload = read_box_payload(fh, hdlr)
    return payload[8:12].decode("latin-1", "replace") if len(payload) >= 12 else ""


def _read_stsz(fh, stsz: Box | None) -> list[int] | None:
    if stsz is None:
        return None
    payload = read_box_payload(fh, stsz)
    if len(payload) < 12:
        return None
    uniform, count = struct.unpack(">II", payload[4:12])
    if uniform:
        return [uniform] * count
    values = payload[12 : 12 + count * 4]
    if len(values) < count * 4:
        return None
    return list(struct.unpack(f">{count}I", values))


def _read_chunk_offsets(fh, stbl: Box) -> list[int] | None:
    stco = stbl.find("stco")
    if stco is not None:
        payload = read_box_payload(fh, stco)
        count = struct.unpack(">I", payload[4:8])[0]
        return list(struct.unpack(f">{count}I", payload[8 : 8 + count * 4]))
    co64 = stbl.find("co64")
    if co64 is not None:
        payload = read_box_payload(fh, co64)
        count = struct.unpack(">I", payload[4:8])[0]
        return list(struct.unpack(f">{count}Q", payload[8 : 8 + count * 8]))
    return None


def _read_stsc(fh, stsc: Box | None) -> list[tuple[int, int]] | None:
    if stsc is None:
        return None
    payload = read_box_payload(fh, stsc)
    count = struct.unpack(">I", payload[4:8])[0]
    out = []
    for i in range(count):
        first, per_chunk, _ = struct.unpack(">III", payload[8 + i * 12 : 20 + i * 12])
        out.append((first, per_chunk))
    return out


def _read_stts(fh, stts: Box | None) -> tuple[int, int]:
    if stts is None:
        return 0, 0
    payload = read_box_payload(fh, stts)
    count = struct.unpack(">I", payload[4:8])[0]
    total = 0
    samples = 0
    for i in range(count):
        n, delta = struct.unpack(">II", payload[8 + i * 8 : 16 + i * 8])
        total += n * delta
        samples += n
    return total, samples


def _samples_in_chunk(stsc: list[tuple[int, int]], chunk_number: int) -> int:
    result = 0
    for first, per_chunk in stsc:
        if first <= chunk_number:
            result = per_chunk
        else:
            break
    return result


def _samples_from_stsc(stsc: list[tuple[int, int]], chunk_count: int) -> int:
    return sum(_samples_in_chunk(stsc, n) for n in range(1, chunk_count + 1))


def verify_decode(path: Path, timeout: int = 3600) -> VerifyReport:
    """Decode the whole file and count what comes out.

    Structure checks say the index is consistent. Only decoding says the index
    points at what it claims to. ffmpeg is optional, and its absence is a
    warning rather than a failure.
    """
    report = VerifyReport()
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        report.warn(
            "ffmpeg was not found. The output was checked for structure. "
            "It was not decoded."
        )
        return report

    probe = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,nb_frames,width,height",
         "-of", "default=noprint_wrappers=1", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    for line in probe.stdout.splitlines():
        name, _, value = line.partition("=")
        if name == "duration" and value not in ("N/A", ""):
            report.duration = float(value)
        elif name == "width" and value.isdigit():
            report.width = int(value)
        elif name == "height" and value.isdigit():
            report.height = int(value)

    decode = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-map", "0", "-f", "null", "-"],
        capture_output=True, text=True, timeout=timeout,
    )
    lines = [
        line for line in decode.stderr.splitlines()
        if line.strip() and "non monotonically increasing dts" not in line
    ]
    report.decoded = True
    report.decode_errors = len(lines)
    if lines:
        report.warn(
            f"the decoder reported {len(lines)} problems, first: {lines[0][:160]}"
        )
    return report
