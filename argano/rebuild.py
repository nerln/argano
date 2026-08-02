"""Writing the index the recorder never wrote.

The output keeps the original media bytes exactly where they were. Nothing is
decoded and nothing is re-encoded, so the picture that comes out is the picture
that went in, at the same quality and the same size. All that is added is the
`moov` describing it, and where the media's own length field was left blank,
that gets filled in.

Every box with a fixed layout is checked against its known length before it is
used. That check exists because of a specific failure: a track header written
four bytes too long still parses, still names its fields in the right order to
anything reading by name, and still plays correctly in QuickTime. What it does
is push the width and height four bytes along, so a player reading by offset
takes the last cell of the display matrix as the width and shows a
picture stretched about ten to one. It looks like a codec problem and it is a
header that nothing complained about.
"""

from __future__ import annotations

import shutil
import struct
from dataclasses import dataclass
from pathlib import Path

from . import atoms
from .atoms import ContainerError, box, full_box, run_length_encode
from .profile import SourceProfile, TrackProfile
from .timeline import AudioTiming, VideoTiming

QUICKTIME_EPOCH_DEFAULT = 0


@dataclass
class TrackData:
    """Everything needed to describe one rebuilt track."""

    profile: TrackProfile
    track_id: int
    sizes: list[int]              # per sample, in bytes
    chunk_offsets: list[int]      # absolute file offsets
    samples_per_chunk: list[int]
    durations: list[int]          # per sample, in media timescale
    composition_offsets: list[int] | None = None
    sync_samples: list[int] | None = None
    edit_media_start: int = 0     # ticks into the media where the edit begins
    empty_edit: int = 0           # ticks of nothing before the track begins
    # Whether starting late means content is thrown away. For audio it does:
    # the priming samples at the head are decoder warm-up and nobody should
    # hear them. For video it does not. Video starts late only so that no frame
    # has to be shown before the frame it was predicted from has been decoded,
    # and every frame is still presented, just shifted along. Subtracting the
    # shift from the duration there quietly cuts the last fraction of a second.
    discards_head: bool = True
    volume: int = 0x0100
    width: int = 0
    height: int = 0


def _time_to_sample(durations: list[int]) -> bytes:
    entries = [
        struct.pack(">II", count, value) for count, value in run_length_encode(durations)
    ]
    return atoms.table(b"stts", entries)


def _composition_offsets(values: list[int]) -> bytes:
    entries = [
        struct.pack(">II", count, value) for count, value in run_length_encode(values)
    ]
    return atoms.table(b"ctts", entries)


def _sample_to_chunk(samples_per_chunk: list[int]) -> bytes:
    entries = []
    first = 1
    for count, value in run_length_encode(samples_per_chunk):
        entries.append(struct.pack(">III", first, value, 1))
        first += count
    return atoms.table(b"stsc", entries)


def _sample_sizes(sizes: list[int]) -> bytes:
    uniform = sizes[0] if sizes and len(set(sizes)) == 1 else 0
    if uniform:
        return full_box(b"stsz", 0, 0, struct.pack(">II", uniform, len(sizes)))
    payload = struct.pack(">II", 0, len(sizes)) + b"".join(
        struct.pack(">I", size) for size in sizes
    )
    return full_box(b"stsz", 0, 0, payload)


def _chunk_offsets(offsets: list[int]) -> bytes:
    """`stco` while the file fits in four gigabytes, `co64` past that."""
    if offsets and offsets[-1] >= (1 << 32) - 1:
        entries = [struct.pack(">Q", value) for value in offsets]
        return atoms.table(b"co64", entries)
    entries = [struct.pack(">I", value) for value in offsets]
    return atoms.table(b"stco", entries)


def _sync_sample(indices: list[int]) -> bytes:
    entries = [struct.pack(">I", value) for value in indices]
    return atoms.table(b"stss", entries)


def _edit_list(track: TrackData, media_duration: int, movie_timescale: int) -> bytes:
    """Say where the presentation starts, in movie ticks.

    Two things get expressed here. Compressed audio begins with priming samples
    that exist to warm the decoder up and are not meant to be heard, and video
    whose frames were reordered starts a fraction of a second late so that no
    frame has to be shown before it is decoded.
    """
    timescale = track.profile.timescale
    entries = []
    if track.empty_edit > 0:
        entries.append(struct.pack(">IiI", track.empty_edit, -1, 0x00010000))
    playable = (
        max(0, media_duration - track.edit_media_start)
        if track.discards_head
        else media_duration
    )
    movie_ticks = (
        int(playable * movie_timescale / timescale) if timescale else playable
    )
    entries.append(struct.pack(">IiI", movie_ticks, track.edit_media_start, 0x00010000))
    return box(b"edts", atoms.table(b"elst", entries))


def _track_header(track: TrackData, duration_in_movie: int, profile: SourceProfile) -> bytes:
    payload = (
        struct.pack(
            ">IIIII",
            profile.creation_time,
            profile.modification_time,
            track.track_id,
            0,
            duration_in_movie,
        )
        + b"\x00" * 8
        + struct.pack(">HHHH", 0, 0, track.volume, 0)
        + profile.matrix
        + struct.pack(">II", track.width << 16, track.height << 16)
    )
    # enabled | in movie | in preview | in poster
    return full_box(b"tkhd", 0, 0x0F, payload)


def _media_header(track: TrackData, duration: int, profile: SourceProfile) -> bytes:
    payload = struct.pack(
        ">IIII",
        profile.creation_time,
        profile.modification_time,
        track.profile.timescale,
        duration,
    ) + struct.pack(">HH", track.profile.language, 0)
    return full_box(b"mdhd", 0, 0, payload)


def _sample_table(track: TrackData) -> bytes:
    parts = [track.profile.stsd]

    if track.profile.sgpd:
        parts.append(track.profile.sgpd)
        parts.append(_roll_group(len(track.sizes)))

    parts.append(_time_to_sample(track.durations))
    if track.composition_offsets is not None:
        parts.append(_composition_offsets(track.composition_offsets))
    if track.sync_samples is not None and len(track.sync_samples) < len(track.sizes):
        parts.append(_sync_sample(track.sync_samples))
    parts.append(_sample_to_chunk(track.samples_per_chunk))
    parts.append(_sample_sizes(track.sizes))
    parts.append(_chunk_offsets(track.chunk_offsets))
    return box(b"stbl", b"".join(parts))


def _roll_group(sample_count: int) -> bytes:
    """Say that every audio sample needs the one before it to sound right."""
    payload = b"roll" + struct.pack(">III", 1, sample_count, 1)
    return full_box(b"sbgp", 0, 0, payload)


def _minimal_dinf() -> bytes:
    dref = atoms.table(b"dref", [full_box(b"url ", 0, 1, b"")])
    return box(b"dinf", dref)


def _handler(handler_type: bytes, name: str) -> bytes:
    payload = b"\x00" * 4 + handler_type + b"\x00" * 12 + name.encode() + b"\x00"
    return full_box(b"hdlr", 0, 0, payload)


def build_track(track: TrackData, profile: SourceProfile) -> tuple[bytes, int]:
    """Build one `trak`, and report how long it runs in movie ticks."""
    media_duration = sum(track.durations)
    timescale = track.profile.timescale or 1
    playable = (
        max(0, media_duration - track.edit_media_start)
        if track.discards_head
        else media_duration
    )
    movie_duration = track.empty_edit + int(
        playable * profile.movie_timescale / timescale
    )

    header = track.profile.media_header
    if header is None:
        header = (
            full_box(b"vmhd", 0, 1, struct.pack(">HHHH", 0, 0, 0, 0))
            if track.profile.handler == "vide"
            else full_box(b"smhd", 0, 0, struct.pack(">hH", 0, 0))
        )
    media_hdlr = track.profile.media_hdlr or _handler(
        track.profile.handler.encode(),
        "Video Handler" if track.profile.handler == "vide" else "Sound Handler",
    )

    minf_parts = [header]
    if track.profile.minf_hdlr:
        minf_parts.append(track.profile.minf_hdlr)
    minf_parts.append(track.profile.dinf or _minimal_dinf())
    minf_parts.append(_sample_table(track))

    mdia = box(
        b"mdia",
        _media_header(track, media_duration, profile)
        + media_hdlr
        + box(b"minf", b"".join(minf_parts)),
    )

    parts = [_track_header(track, movie_duration, profile)]
    if track.profile.tapt:
        parts.append(track.profile.tapt)
    parts.append(_edit_list(track, media_duration, profile.movie_timescale))
    parts.append(mdia)
    return box(b"trak", b"".join(parts)), movie_duration


def build_moov(tracks: list[TrackData], profile: SourceProfile) -> bytes:
    """Assemble the whole index."""
    if not tracks:
        raise ContainerError("there is nothing to build an index for")
    built = []
    longest = 0
    for track in tracks:
        data, duration = build_track(track, profile)
        built.append(data)
        longest = max(longest, duration)

    mvhd_payload = (
        struct.pack(
            ">IIII",
            profile.creation_time,
            profile.modification_time,
            profile.movie_timescale,
            longest,
        )
        + struct.pack(">IH", 0x00010000, 0x0100)
        + b"\x00" * 10
        + profile.matrix
        + b"\x00" * 24
        + struct.pack(">I", max(t.track_id for t in tracks) + 1)
    )
    mvhd = full_box(b"mvhd", 0, 0, mvhd_payload)
    return box(b"moov", mvhd + b"".join(built))


DEFAULT_FTYP = box(b"ftyp", b"qt  " + struct.pack(">I", 0x20050300) + b"qt  ")


def media_header_length(media_size: int) -> int:
    """8 bytes, or 16 when the media is too big for a 32-bit length."""
    return 16 if media_size + 8 >= (1 << 32) else 8


def plan_layout(ftyp: bytes, media_size: int) -> tuple[int, bytes]:
    """Where the media lands in the output, and the `mdat` header in front of it.

    The output is written rather than patched, so the layout is chosen here
    instead of inherited. That solves a problem a patch cannot: an unfinalised
    recording over four gigabytes has an eight-byte media header and needs a
    sixteen-byte one, and there is nowhere to put the extra bytes without
    moving the media. Moving it is free when the file is being written out
    anyway, and every chunk offset shifts by the same amount.
    """
    header_length = media_header_length(media_size)
    if header_length == 16:
        header = struct.pack(">I", 1) + b"mdat" + struct.pack(">Q", media_size + 16)
    else:
        header = struct.pack(">I", media_size + 8) + b"mdat"
    return len(ftyp) + header_length, header


def write_repaired(
    source: Path,
    destination: Path,
    ftyp: bytes,
    mdat_header: bytes,
    media_start: int,
    media_end: int,
    moov: bytes,
    moov_first: bool = False,
    progress=None,
) -> None:
    """Write the output: identity, media, index.

    The media is copied byte for byte and the original is left alone. Whether a
    repair came out right is not always obvious on first viewing, and having
    the input still there is what makes a second attempt possible.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = media_end - media_start
    chunk = 8 << 20
    with source.open("rb") as src, destination.open("wb") as dst:
        dst.write(ftyp)
        if moov_first:
            dst.write(moov)
        dst.write(mdat_header)
        src.seek(media_start)
        copied = 0
        while copied < total:
            data = src.read(min(chunk, total - copied))
            if not data:
                break
            dst.write(data)
            copied += len(data)
            if progress is not None:
                progress(copied, total)
        if not moov_first:
            dst.write(moov)
