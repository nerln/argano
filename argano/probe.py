"""Working out what is actually wrong with a file.

Most damaged video comes from one of a few accidents, and they need different
things. A recording that was interrupted has all its media and no index. A
partial download has an index and only some of its media. A file with a bad
sector has both and a hole in the middle. Telling the user which of those they
have, before anything is attempted, is worth more than a progress bar.

The test that matters is whether the index is present and readable. If it is,
the file describes itself and there may be nothing to repair. If it is not,
the media is still there, and the question becomes where the description can
be borrowed from.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .atoms import Box, parse_boxes

MEDIA_TYPES = (b"mdat",)


@dataclass
class Diagnosis:
    path: Path
    size: int
    top_level: list[tuple[str, int, int]] = field(default_factory=list)
    media_start: int = 0
    media_end: int = 0
    has_index: bool = False
    index_readable: bool = False
    declared_media_size: int | None = None
    unfinalised: bool = False
    truncated: bool = False
    verdict: str = ""
    detail: str = ""
    tracks: list[str] = field(default_factory=list)

    @property
    def media_size(self) -> int:
        return max(0, self.media_end - self.media_start)

    @property
    def repairable(self) -> bool:
        return self.media_size > 0

    @property
    def needs_reference(self) -> bool:
        return self.repairable and not self.index_readable


def diagnose(path: Path | str) -> Diagnosis:
    path = Path(path)
    size = path.stat().st_size
    result = Diagnosis(path=path, size=size)

    with path.open("rb") as fh:
        boxes = parse_boxes(fh, 0, size)
        result.top_level = [(b.name, b.offset, b.size) for b in boxes]

        media = next((b for b in boxes if b.type in MEDIA_TYPES), None)
        moov = next((b for b in boxes if b.type == b"moov"), None)

        if media is not None:
            result.media_start = media.payload_offset
            result.media_end = media.end
            # A recorder writes the length last. Finding it still blank is the
            # signature of a recording that was never closed.
            fh.seek(media.offset)
            declared = int.from_bytes(fh.read(4), "big")
            result.declared_media_size = declared
            result.unfinalised = declared == 0
            result.truncated = media.truncated

        if moov is not None:
            result.has_index = True
            traks = moov.find_all("trak")
            result.index_readable = bool(traks) and not moov.truncated
            for trak in traks:
                stsd = trak.find("mdia/minf/stbl/stsd")
                hdlr = trak.find("mdia/hdlr")
                kind = "track"
                if hdlr is not None:
                    fh.seek(hdlr.payload_offset + 8)
                    kind = fh.read(4).decode("latin-1", "replace")
                codec = "?"
                if stsd is not None:
                    fh.seek(stsd.payload_offset + 12)
                    codec = fh.read(4).decode("latin-1", "replace")
                result.tracks.append(f"{kind}:{codec}")

    _describe(result)
    return result


def _describe(result: Diagnosis) -> None:
    if result.media_size == 0:
        result.verdict = "no media found"
        result.detail = (
            "There is no mdat box holding audio or video, so there is nothing "
            "here to rebuild an index around. The file may be a different "
            "format than its name suggests."
        )
        return

    portion = result.media_size / result.size if result.size else 0

    if result.index_readable and not result.unfinalised:
        result.verdict = "index present"
        result.detail = (
            "The file has a readable index. If it still will not play, the "
            "problem is inside the media rather than around it, and rebuilding "
            "the index from the stream can still help."
        )
        return

    if result.unfinalised:
        result.verdict = "recording never finalised"
        result.detail = (
            "The media length was never filled in, which is what a recorder "
            f"leaves behind when it stops without closing the file. All "
            f"{result.media_size / 1e6:.0f} MB of media is present and the "
            "index that describes it was never written."
        )
        return

    if result.has_index and not result.index_readable:
        result.verdict = "index damaged"
        result.detail = (
            "There is an index but it cannot be read through. The media is "
            "intact underneath it and can be indexed again from scratch."
        )
        return

    result.verdict = "index missing"
    result.detail = (
        f"The media is {portion * 100:.0f} percent of the file and there is no "
        "index describing it."
    )
