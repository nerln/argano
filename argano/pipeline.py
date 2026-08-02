"""The whole repair, start to finish.

Read the file to find out what is wrong with it. Learn the codec settings from
somewhere: a working file from the same source, the damaged file's own index if
enough of it survived, or the stream itself when the encoder repeated its
parameter sets. Walk the media and find the samples. Split the audio with a
decoder. Put the frames back on a clock the audio keeps. Write a new index.
Then check the result properly, and say what was lost.

Nothing in here decodes or re-encodes a picture. The media bytes in the output
are the media bytes from the input, so a repair costs no quality and the
original stays on disk either way.
"""

from __future__ import annotations

import mmap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import rebuild, scanner
from .codecs.aac import AacCodec, PcmCodec, frame_is_plausible
from .codecs.base import AudioCodec, VideoCodec
from .codecs.h264 import H264Codec
from .codecs.hevc import HevcCodec
from .probe import Diagnosis, diagnose
from .profile import SourceProfile, TrackProfile, read_profile
from .rebuild import TrackData, build_moov, plan_layout, write_repaired
from .scanner import MediaScanner, ScanResult
from .timeline import (
    audio_anchored_slots,
    build_video_timing,
    fixed_rate_slots,
    unwrap_picture_order,
)
from .verify import VerifyReport, verify_decode, verify_structure

VIDEO_CODECS: dict[bytes, type[VideoCodec]] = {
    b"avc1": H264Codec,
    b"avc3": H264Codec,
    b"hvc1": HevcCodec,
    b"hev1": HevcCodec,
}

AUDIO_CODECS: dict[bytes, type[AudioCodec]] = {
    b"mp4a": AacCodec,
}

PCM_FOURCCS = frozenset({b"sowt", b"twos", b"raw ", b"lpcm", b"in24", b"fl32"})

Progress = Callable[[str, float, str], None]


class RepairError(RuntimeError):
    """The repair cannot go on, with a reason a person can act on."""


@dataclass
class RepairOptions:
    output: Path | None = None
    reference: Path | None = None
    fps: float | None = None            # only used when there is no audio to follow
    faststart: bool = False
    check_decode: bool = True
    keep_suspect_audio: bool = False
    confirm_samples: int = scanner.CONFIRM_SAMPLES


@dataclass
class RepairResult:
    output: Path
    diagnosis: Diagnosis
    scan: ScanResult
    video_frames: int = 0
    audio_frames: int = 0
    duration: float = 0.0
    timing_model: str = ""
    dropped_audio_frames: int = 0
    audio_note: str = ""
    profile_source: str = ""
    report: VerifyReport | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def lost_seconds(self) -> float:
        """Roughly how much of the recording the damage cost."""
        if not self.duration or not self.scan.video:
            return 0.0
        media = self.scan.video_bytes + self.scan.audio_bytes
        if media <= 0:
            return 0.0
        return self.duration * self.scan.damaged_bytes / media


def _noop(stage: str, fraction: float, note: str = "") -> None:
    return


def choose_profile(
    diagnosis: Diagnosis, options: RepairOptions
) -> tuple[SourceProfile, str]:
    """Find something that can describe this media.

    A reference wins when one is given, because it is a direct statement of how
    these files are built. Failing that, a damaged file often still has a
    readable index, and it describes itself.
    """
    if options.reference:
        return read_profile(options.reference), f"reference file {options.reference.name}"
    if diagnosis.index_readable:
        return read_profile(diagnosis.path), "the file's own surviving index"
    raise RepairError(
        "This file has no index left to read and no reference was given. "
        "Point the repair at a working video from the same camera or app, "
        "recorded at the same setting, and its description will be used."
    )


def _make_video_codec(track: TrackProfile | None) -> VideoCodec | None:
    if track is None:
        return None
    factory = VIDEO_CODECS.get(track.fourcc)
    if factory is None:
        raise RepairError(
            f"The video is {track.fourcc.decode('latin-1', 'replace')}, which this "
            f"cannot walk yet. H.264 and H.265 are supported."
        )
    codec = factory()
    if track.codec_config:
        codec.configure(track.codec_config)
    if track.slices_per_picture:
        codec.max_slices = track.slices_per_picture
    if track.largest_sample:
        # Eight times the biggest frame the reference holds, and never less
        # than one byte per pixel. The reference may be a short clip of a still
        # scene while the damaged file holds fireworks, so the allowance has to
        # be generous. It is still far below the point where a length read out
        # of noise can pass as a frame.
        codec.max_sample_size = max(track.largest_sample * 8, track.width * track.height)
    return codec


def _make_audio_codec(track: TrackProfile | None) -> AudioCodec | None:
    if track is None:
        return None
    if track.fourcc in PCM_FOURCCS:
        return PcmCodec(bytes_per_sample=2, channels=max(1, track.channels))
    factory = AUDIO_CODECS.get(track.fourcc)
    if factory is None:
        return None
    codec = factory()
    codec.channels = track.channels
    if track.codec_config:
        codec.configure(track.codec_config)
    return codec


def repair(
    path: Path | str,
    options: RepairOptions | None = None,
    progress: Progress | None = None,
) -> RepairResult:
    path = Path(path)
    options = options or RepairOptions()
    report_progress = progress or _noop

    report_progress("inspect", 0.0, "reading the file structure")
    diagnosis = diagnose(path)
    if not diagnosis.repairable:
        raise RepairError(diagnosis.detail)

    profile, profile_source = choose_profile(diagnosis, options)
    video_codec = _make_video_codec(profile.video)
    audio_codec = _make_audio_codec(profile.audio)

    output = options.output or path.with_name(f"{path.stem} (repaired){path.suffix}")
    result = RepairResult(
        output=output, diagnosis=diagnosis, scan=ScanResult(),
        profile_source=profile_source,
    )

    with path.open("rb") as fh:
        data = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            if video_codec is not None and not video_codec.configured:
                report_progress("inspect", 0.05, "looking for codec settings in the stream")
                found = scanner.find_parameter_sets(
                    data[diagnosis.media_start : diagnosis.media_start + (64 << 20)],
                    video_codec,
                )
                if not found or not video_codec.configured:
                    raise RepairError(
                        "The codec settings are not in the reference and the stream "
                        "does not repeat them. A working file from the same source "
                        "is needed to read this one."
                    )
                result.warnings.append(
                    "codec settings were taken from the stream rather than an index"
                )

            report_progress("scan", 0.0, "finding the frames")

            def on_scan(done: int, total: int) -> None:
                report_progress("scan", done / total if total else 0.0, "finding the frames")

            walker = MediaScanner(
                data,
                video_codec,
                has_audio=audio_codec is not None,
                confirm=options.confirm_samples,
                audio_boundaries=_audio_boundaries(data, audio_codec),
            )
            scan = walker.scan(diagnosis.media_start, diagnosis.media_end, progress=on_scan)
            result.scan = scan
            if not scan.video and not scan.audio_spans:
                raise RepairError(
                    "Nothing in the media read as a frame. Either the codec settings "
                    "do not match this file, or the media is encrypted or scrambled."
                )

            report_progress("audio", 0.0, "splitting the sound into frames")
            audio_frames, per_span, audio_note, dropped = _segment_audio(
                data, scan, audio_codec, options, report_progress
            )
            result.audio_note = audio_note
            result.dropped_audio_frames = dropped

            report_progress("timeline", 0.0, "putting the frames back on a clock")
            tracks, duration, model = _build_tracks(
                scan, audio_frames, per_span, profile, video_codec, audio_codec, options
            )
            result.timing_model = model
            result.duration = duration
            result.video_frames = len(scan.video)
            result.audio_frames = len(audio_frames)
        finally:
            data.close()

    report_progress("write", 0.0, "writing the repaired file")
    _write(path, output, tracks, profile, diagnosis, options, report_progress)

    report_progress("verify", 0.0, "checking the result")
    expected = None
    if profile.video and profile.video.width:
        expected = (profile.video.width, profile.video.height)
    report = verify_structure(output, expected)
    if options.check_decode:
        decode_report = verify_decode(output)
        report.findings.extend(decode_report.findings)
        report.decoded = decode_report.decoded
        report.decode_errors = decode_report.decode_errors
        report.duration = decode_report.duration or report.duration
        report.width = decode_report.width or report.width
        report.height = decode_report.height or report.height
    result.report = report
    report_progress("done", 1.0, "")
    return result


def _audio_boundaries(data, audio_codec: AudioCodec | None):
    """Give the scanner a way to walk the frame boundaries of a run of sound."""
    if audio_codec is None or not audio_codec.available:
        return None

    def walk(start: int, limit: int):
        return audio_codec.boundaries(data, start, limit)

    return walk


def _segment_audio(
    data, scan: ScanResult, audio_codec: AudioCodec | None,
    options: RepairOptions, report_progress: Progress,
):
    """Split every audio run into frames, and note what could not be read."""
    if audio_codec is None or not scan.audio_spans:
        return [], [0] * len(scan.audio_spans), "", 0

    if not audio_codec.available:
        scan.audio_spans.clear()
        return [], [], (
            f"The sound was left out: {audio_codec.unavailable_reason}. "
            f"The picture is unaffected."
        ), 0

    frames: list[tuple[int, int, int]] = []       # offset, size, duration
    per_span: list[int] = []
    dropped = 0
    channels = getattr(audio_codec, "channels", 0)
    total = len(scan.audio_spans)

    for index, (offset, length) in enumerate(scan.audio_spans):
        chunk = data[offset : offset + length]
        try:
            span_frames, skipped = audio_codec.segment(chunk, offset)
        except RuntimeError:
            span_frames, skipped = [], length

        if skipped and not options.keep_suspect_audio:
            # This run contained damage, so what decoded inside it is suspect.
            # Anything the format does not actually allow gets dropped, because
            # a stricter decoder downstream would refuse the file over it.
            kept = [
                frame for frame in span_frames
                if frame_is_plausible(data, frame.offset, frame.size, channels)
            ]
            dropped += len(span_frames) - len(kept)
            span_frames = kept

        if skipped:
            scan.damage.append(
                scanner.Damage(offset, skipped, "unreadable-audio",
                               "bytes inside an audio run that no frame could be read from")
            )

        per_span.append(sum(frame.duration for frame in span_frames))
        frames.extend((frame.offset, frame.size, frame.duration) for frame in span_frames)
        if index % 64 == 0:
            report_progress("audio", index / total if total else 0, "splitting the sound into frames")

    note = ""
    if dropped:
        note = f"{dropped} audio frames inside damaged runs were left out"
    return frames, per_span, note, dropped


def _build_tracks(
    scan: ScanResult,
    audio_frames: list[tuple[int, int, int]],
    per_span: list[int],
    profile: SourceProfile,
    video_codec: VideoCodec | None,
    audio_codec: AudioCodec | None,
    options: RepairOptions,
) -> tuple[list[TrackData], float, str]:
    tracks: list[TrackData] = []
    duration = 0.0
    model = ""
    track_id = 1

    audio_timescale = 0
    if audio_frames and profile.audio:
        audio_timescale = profile.audio.sample_rate or profile.audio.timescale

    if scan.video and profile.video and video_codec is not None:
        if audio_frames and audio_timescale:
            timescale = audio_timescale
            slots, model = audio_anchored_slots(scan, per_span, timescale)
        else:
            timescale = profile.video.timescale or 600
            fps = options.fps or 30.0
            slots, model = fixed_rate_slots(len(scan.video), timescale, fps)

        ranks = unwrap_picture_order(scan.video, getattr(video_codec, "max_poc_lsb", 0))
        timing = build_video_timing(scan.video, slots, ranks, timescale, model)

        video_profile = TrackProfile(**{**profile.video.__dict__, "timescale": timescale})
        sizes = [sample.size for sample in scan.video]
        offsets, per_chunk = _chunk_layout([s.offset for s in scan.video],
                                           [s.chunk for s in scan.video])
        tracks.append(
            TrackData(
                profile=video_profile,
                track_id=track_id,
                sizes=sizes,
                chunk_offsets=offsets,
                samples_per_chunk=per_chunk,
                durations=timing.durations,
                composition_offsets=timing.ctts if any(timing.ctts) else None,
                sync_samples=timing.sync_samples,
                edit_media_start=timing.presentation_delay,
                discards_head=False,
                volume=0,
                width=profile.video.width,
                height=profile.video.height,
            )
        )
        duration = timing.duration / timescale if timescale else 0.0
        track_id += 1

    if audio_frames and profile.audio:
        timescale = audio_timescale
        audio_profile = TrackProfile(**{**profile.audio.__dict__, "timescale": timescale})
        offsets, per_chunk = _contiguous_chunks(audio_frames)
        durations = [frame[2] for frame in audio_frames]
        delay = profile.audio.encoder_delay
        empty = profile.audio.empty_edit
        tracks.append(
            TrackData(
                profile=audio_profile,
                track_id=track_id,
                sizes=[frame[1] for frame in audio_frames],
                chunk_offsets=offsets,
                samples_per_chunk=per_chunk,
                durations=durations,
                edit_media_start=delay,
                empty_edit=empty,
                volume=0x0100,
            )
        )
        duration = max(duration, sum(durations) / timescale if timescale else 0.0)

    if not tracks:
        raise RepairError("Nothing could be indexed out of this file.")
    return tracks, duration, model


def _chunk_layout(offsets: list[int], chunk_ids: list[int]) -> tuple[list[int], list[int]]:
    """First offset of each chunk, and how many samples it holds."""
    chunk_offsets: list[int] = []
    per_chunk: list[int] = []
    current = None
    for offset, chunk in zip(offsets, chunk_ids):
        if chunk != current:
            chunk_offsets.append(offset)
            per_chunk.append(0)
            current = chunk
        per_chunk[-1] += 1
    return chunk_offsets, per_chunk


def _contiguous_chunks(frames: list[tuple[int, int, int]]) -> tuple[list[int], list[int]]:
    """Group frames that sit back to back into chunks."""
    offsets: list[int] = []
    per_chunk: list[int] = []
    expected = -1
    for offset, size, _duration in frames:
        if offset != expected:
            offsets.append(offset)
            per_chunk.append(0)
        per_chunk[-1] += 1
        expected = offset + size
    return offsets, per_chunk


def _write(
    source: Path,
    output: Path,
    tracks: list[TrackData],
    profile: SourceProfile,
    diagnosis: Diagnosis,
    options: RepairOptions,
    report_progress: Progress,
) -> None:
    """Lay the output out, shift every offset to match, and write it.

    The media moves, because the output is written from scratch rather than
    patched. How far it moves depends only on the header in front of it, so
    every chunk offset shifts by the same amount. Putting the index first costs
    one extra round: its own length changes where the media starts, so the
    offsets are recomputed until the two agree.
    """
    ftyp = rebuild.DEFAULT_FTYP
    media_size = diagnosis.media_end - diagnosis.media_start
    media_offset, mdat_header = plan_layout(ftyp, media_size)

    def shifted(delta: int) -> list[TrackData]:
        return [
            TrackData(**{**track.__dict__,
                         "chunk_offsets": [o + delta for o in track.chunk_offsets]})
            for track in tracks
        ]

    if options.faststart:
        moov_length = 0
        for _ in range(4):
            delta = media_offset + moov_length - diagnosis.media_start
            moov = build_moov(shifted(delta), profile)
            if len(moov) == moov_length:
                break
            moov_length = len(moov)
        delta = media_offset + moov_length - diagnosis.media_start
        moov = build_moov(shifted(delta), profile)
        if len(moov) != moov_length:
            # The length would not settle, so fall back to the index at the end,
            # which never depends on its own size.
            options.faststart = False

    if not options.faststart:
        delta = media_offset - diagnosis.media_start
        moov = build_moov(shifted(delta), profile)

    def on_write(done: int, total: int) -> None:
        report_progress("write", done / total if total else 0.0, "writing the repaired file")

    write_repaired(
        source=source,
        destination=output,
        ftyp=ftyp,
        mdat_header=mdat_header,
        media_start=diagnosis.media_start,
        media_end=diagnosis.media_end,
        moov=moov,
        moov_first=options.faststart,
        progress=on_write,
    )
