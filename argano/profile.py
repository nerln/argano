"""What a working file can teach us about a broken one.

Rebuilding an index needs facts the damaged file no longer states: which codec
this is, how the decoder should be configured, what the clock runs at, how big
the picture is. All of that lives in `moov`, which is the part that is gone.

Two places can supply it. If the recording that broke has a sibling that
completed, from the same camera or the same app, its `moov` describes the same
encoder settings and can be read straight off. Failing that, some encoders
repeat their parameter sets inside the stream itself, and those can be lifted
out of `mdat` with no second file at all.

What gets taken from a reference is deliberately raw. The sample description,
the handler boxes, the aperture box: these are copied across as bytes rather
than parsed and rebuilt from fields. A rebuilt descriptor is a chance to get a
detail wrong for no gain, and copying keeps colour information, encoder names
and vendor boxes intact instead of quietly dropping them.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

from . import atoms
from .atoms import Box, parse_boxes, read_box_payload


@dataclass
class TrackProfile:
    """One track's worth of description, ready to be written into a new index."""

    handler: str                     # 'vide' or 'soun'
    fourcc: bytes                    # 'avc1', 'hvc1', 'mp4a', ...
    stsd: bytes                      # the whole sample description box
    codec_config: bytes              # avcC / hvcC payload, or esds payload
    timescale: int
    language: int = 0x55C4           # undetermined
    width: int = 0
    height: int = 0
    sample_rate: int = 0
    channels: int = 0
    tapt: bytes | None = None        # QuickTime clean aperture
    media_header: bytes | None = None    # vmhd or smhd
    media_hdlr: bytes | None = None      # the hdlr inside mdia
    minf_hdlr: bytes | None = None       # the data handler inside minf
    dinf: bytes | None = None
    sgpd: bytes | None = None
    sbgp_template: bytes | None = None
    encoder_delay: int = 0           # priming samples an edit list should skip
    empty_edit: int = 0              # movie-timescale ticks before the track starts
    slices_per_picture: int = 0      # 0 when it was not worked out
    largest_sample: int = 0          # the biggest frame the reference contains
    samples_per_chunk: list[int] = field(default_factory=list)


@dataclass
class SourceProfile:
    """Everything learned about how these files are built."""

    video: TrackProfile | None = None
    audio: TrackProfile | None = None
    movie_timescale: int = 600
    creation_time: int = 0
    modification_time: int = 0
    matrix: bytes = atoms.IDENTITY_MATRIX
    source: str = ""
    brand: bytes = b"qt  "

    @property
    def complete(self) -> bool:
        return self.video is not None or self.audio is not None


def read_profile(path: Path | str) -> SourceProfile:
    """Learn from a file that still has a usable index."""
    path = Path(path)
    size = path.stat().st_size
    profile = SourceProfile(source=str(path))
    with path.open("rb") as fh:
        boxes = parse_boxes(fh, 0, size)
        ftyp = next((b for b in boxes if b.type == b"ftyp"), None)
        if ftyp is not None and ftyp.payload_size >= 4:
            profile.brand = read_box_payload(fh, ftyp)[:4]

        moov = next((b for b in boxes if b.type == b"moov"), None)
        if moov is None:
            raise ValueError(f"{path.name} has no moov to learn from")

        mvhd = moov.find("mvhd")
        if mvhd is not None:
            payload = read_box_payload(fh, mvhd)
            version = payload[0]
            if version == 0 and len(payload) >= 24:
                (profile.creation_time, profile.modification_time,
                 profile.movie_timescale) = struct.unpack(">III", payload[4:16])
            elif len(payload) >= 36:
                created, modified, timescale = struct.unpack(">QQI", payload[4:28])
                profile.creation_time = created & 0xFFFFFFFF
                profile.modification_time = modified & 0xFFFFFFFF
                profile.movie_timescale = timescale

        for trak in moov.find_all("trak"):
            track = _read_track(fh, trak, profile.movie_timescale)
            if track is None:
                continue
            if track.handler == "vide" and profile.video is None:
                profile.video = track
            elif track.handler == "soun" and profile.audio is None:
                profile.audio = track

    if not profile.complete:
        raise ValueError(f"{path.name} has no video or audio track to learn from")
    return profile


def _box_bytes(fh, box: Box | None) -> bytes | None:
    if box is None:
        return None
    fh.seek(box.offset)
    return fh.read(box.size)


def _read_track(fh, trak: Box, movie_timescale: int) -> TrackProfile | None:
    mdia = trak.find("mdia")
    if mdia is None:
        return None
    hdlr = mdia.find("hdlr")
    if hdlr is None:
        return None
    handler = read_box_payload(fh, hdlr)[8:12].decode("latin-1", "replace")
    if handler not in ("vide", "soun"):
        return None

    mdhd = mdia.find("mdhd")
    timescale = 600
    language = 0x55C4
    if mdhd is not None:
        payload = read_box_payload(fh, mdhd)
        if payload[0] == 0 and len(payload) >= 20:
            timescale = struct.unpack(">I", payload[12:16])[0]
            language = struct.unpack(">H", payload[20:22])[0] if len(payload) >= 22 else language
        elif len(payload) >= 28:
            timescale = struct.unpack(">I", payload[20:24])[0]

    stbl = mdia.find("minf/stbl")
    if stbl is None:
        return None
    stsd = stbl.find("stsd")
    if stsd is None:
        return None
    stsd_bytes = _box_bytes(fh, stsd)
    entry = _first_sample_entry(fh, stsd)
    if entry is None:
        return None
    fourcc, width, height, sample_rate, channels, config = entry

    track = TrackProfile(
        handler=handler,
        fourcc=fourcc,
        stsd=stsd_bytes,
        codec_config=config,
        timescale=timescale,
        language=language,
        width=width,
        height=height,
        sample_rate=sample_rate or timescale,
        channels=channels,
        tapt=_box_bytes(fh, trak.find("tapt")),
        media_header=_box_bytes(fh, mdia.find("minf/vmhd") or mdia.find("minf/smhd")),
        media_hdlr=_box_bytes(fh, hdlr),
        minf_hdlr=_box_bytes(fh, mdia.find("minf/hdlr")),
        dinf=_box_bytes(fh, mdia.find("minf/dinf")),
        sgpd=_box_bytes(fh, stbl.find("sgpd")),
        sbgp_template=_box_bytes(fh, stbl.find("sbgp")),
    )
    _read_edit_list(fh, trak, track, movie_timescale)
    track.samples_per_chunk = _read_chunk_shape(fh, stbl)
    if handler == "vide":
        track.slices_per_picture = _count_slices_per_picture(fh, stbl, track)
        sizes = _read_sizes(fh, stbl.find("stsz"))
        track.largest_sample = max(sizes) if sizes else 0
    return track


def _count_slices_per_picture(fh, stbl: Box, track: TrackProfile) -> int:
    """How many pieces this encoder cuts a picture into.

    Almost every camera and screen recorder writes one, and knowing that makes
    reading the damaged file exact: a frame ends after its first slice and
    nothing else can be added to it. Without the answer the walk has to allow
    for more pieces, and a run of sound after the last real slice will
    sometimes read as another one, which is how a frame of twenty-six
    kilobytes comes out twenty megabytes long.

    The reference file has an index, so the question can simply be looked up:
    take a few of its samples and count the slices inside them.
    """
    sizes = _read_sizes(fh, stbl.find("stsz"))
    offsets = _read_offsets(fh, stbl)
    counts = _read_stsc(fh, stbl.find("stsc"))
    if not sizes or not offsets or not counts:
        return 0

    length_size = 4
    if track.codec_config and len(track.codec_config) > 4:
        if track.fourcc in (b"hvc1", b"hev1"):
            length_size = (track.codec_config[21] & 3) + 1 if len(track.codec_config) > 21 else 4
        else:
            length_size = (track.codec_config[4] & 3) + 1
    is_hevc = track.fourcc in (b"hvc1", b"hev1")

    most = 0
    index = 0
    for chunk_number, chunk_offset in enumerate(offsets[:8], start=1):
        per_chunk = _samples_in_chunk(counts, chunk_number)
        position = chunk_offset
        for _ in range(per_chunk):
            if index >= len(sizes) or index >= 40:
                return most
            fh.seek(position)
            sample = fh.read(sizes[index])
            most = max(most, _count_slices(sample, length_size, is_hevc))
            position += sizes[index]
            index += 1
    return most


def _count_slices(sample: bytes, length_size: int, is_hevc: bool) -> int:
    slices = 0
    pos = 0
    while pos + length_size + 2 <= len(sample):
        length = int.from_bytes(sample[pos : pos + length_size], "big")
        if length <= 0 or pos + length_size + length > len(sample):
            break
        header = sample[pos + length_size]
        nal_type = ((header >> 1) & 0x3F) if is_hevc else (header & 0x1F)
        if (is_hevc and nal_type < 32) or (not is_hevc and 1 <= nal_type <= 5):
            slices += 1
        pos += length_size + length
    return slices


def _read_sizes(fh, stsz: Box | None) -> list[int]:
    if stsz is None:
        return []
    payload = read_box_payload(fh, stsz)
    if len(payload) < 12:
        return []
    uniform, count = struct.unpack(">II", payload[4:12])
    count = min(count, 64)
    if uniform:
        return [uniform] * count
    return list(struct.unpack(f">{count}I", payload[12 : 12 + count * 4]))


def _read_offsets(fh, stbl: Box) -> list[int]:
    stco = stbl.find("stco")
    if stco is not None:
        payload = read_box_payload(fh, stco)
        count = min(struct.unpack(">I", payload[4:8])[0], 8)
        return list(struct.unpack(f">{count}I", payload[8 : 8 + count * 4]))
    co64 = stbl.find("co64")
    if co64 is not None:
        payload = read_box_payload(fh, co64)
        count = min(struct.unpack(">I", payload[4:8])[0], 8)
        return list(struct.unpack(f">{count}Q", payload[8 : 8 + count * 8]))
    return []


def _read_stsc(fh, stsc: Box | None) -> list[tuple[int, int]]:
    if stsc is None:
        return []
    payload = read_box_payload(fh, stsc)
    count = min(struct.unpack(">I", payload[4:8])[0], 64)
    out = []
    for i in range(count):
        first, per_chunk, _ = struct.unpack(">III", payload[8 + i * 12 : 20 + i * 12])
        out.append((first, per_chunk))
    return out


def _samples_in_chunk(entries: list[tuple[int, int]], chunk_number: int) -> int:
    result = 0
    for first, per_chunk in entries:
        if first <= chunk_number:
            result = per_chunk
        else:
            break
    return result


def _first_sample_entry(fh, stsd: Box):
    """Pull the codec, geometry and configuration out of the first entry."""
    payload = read_box_payload(fh, stsd)
    if len(payload) < 16:
        return None
    count = struct.unpack(">I", payload[4:8])[0]
    if count < 1:
        return None
    entry = payload[8:]
    entry_size = struct.unpack(">I", entry[0:4])[0]
    fourcc = entry[4:8]
    body = entry[:entry_size]

    width = height = sample_rate = channels = 0
    config = b""

    # A visual sample entry is a fixed 86-byte block before its children: the
    # geometry at 32, then resolutions, a 32-byte compressor name, the pixel
    # depth and a colour table index. An audio entry is 36 bytes, or 52 in the
    # version QuickTime writes, and the codec record sits behind that.
    if len(body) >= 86 and _looks_visual(body):
        width, height = struct.unpack(">HH", body[32:36])
        config = _find_child(body, 86, (b"avcC", b"hvcC", b"av1C", b"vpcC"))
    elif len(body) >= 36:
        channels, _bits = struct.unpack(">HH", body[24:28])
        sample_rate = struct.unpack(">I", body[32:36])[0] >> 16
        version = struct.unpack(">H", body[16:18])[0]
        start = 36 + (16 if version == 1 else 0) + (36 if version == 2 else 0)
        config = _find_child(body, start, (b"esds",))
        if not config:
            wave = _find_child(body, start, (b"wave",))
            if wave:
                config = _find_child(wave, 0, (b"esds",))
        if version == 2 and len(body) >= 44:
            sample_rate = int(struct.unpack(">d", body[36:44])[0])

    return fourcc, width, height, sample_rate, channels, config


def _looks_visual(body: bytes) -> bool:
    """A visual entry ends its fixed block with a 16-bit depth and a -1 table index."""
    return len(body) >= 86 and body[84:86] == b"\xff\xff"


def _find_child(body: bytes, start: int, wanted: tuple[bytes, ...]) -> bytes:
    """Scan the children of a sample entry for one of `wanted`, return its payload."""
    pos = start
    while pos + 8 <= len(body):
        size = struct.unpack(">I", body[pos : pos + 4])[0]
        type_ = body[pos + 4 : pos + 8]
        if size < 8 or pos + size > len(body):
            break
        if type_ in wanted:
            return body[pos + 8 : pos + size]
        pos += size
    return b""


def _read_edit_list(fh, trak: Box, track: TrackProfile, movie_timescale: int) -> None:
    """Recover how the file expressed encoder delay.

    Compressed audio starts with priming samples that are decoded and thrown
    away. The file says so with an edit list: an empty edit that holds the
    track back, then an edit that starts a little way into the media. Copying
    that intent keeps a rebuilt file in sync with the original instead of
    running the sound a few dozen milliseconds early.
    """
    elst = trak.find("edts/elst")
    if elst is None:
        return
    payload = read_box_payload(fh, elst)
    if len(payload) < 8:
        return
    version = payload[0]
    count = struct.unpack(">I", payload[4:8])[0]
    pos = 8
    for _ in range(count):
        if version == 1:
            if pos + 20 > len(payload):
                break
            duration, media_time = struct.unpack(">Qq", payload[pos : pos + 16])
            pos += 20
        else:
            if pos + 12 > len(payload):
                break
            duration, media_time = struct.unpack(">Ii", payload[pos : pos + 8])
            pos += 12
        if media_time < 0:
            track.empty_edit = max(track.empty_edit, int(duration))
        elif media_time > 0 and track.encoder_delay == 0:
            track.encoder_delay = int(media_time)


def _read_chunk_shape(fh, stbl: Box) -> list[int]:
    """How many samples the writer put in each chunk, as a hint for the scanner."""
    stsc = stbl.find("stsc")
    if stsc is None:
        return []
    payload = read_box_payload(fh, stsc)
    if len(payload) < 8:
        return []
    count = struct.unpack(">I", payload[4:8])[0]
    out = []
    pos = 8
    for _ in range(min(count, 64)):
        if pos + 12 > len(payload):
            break
        _first, per_chunk, _desc = struct.unpack(">III", payload[pos : pos + 12])
        out.append(per_chunk)
        pos += 12
    return out
