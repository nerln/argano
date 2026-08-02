"""What a codec has to be able to tell the scanner.

The scanner walks a wall of bytes with no index and has to decide, at every
position, whether a sample starts there. It cannot do that on its own, so each
codec answers two questions: how long is the sample that starts here, and is
what I am looking at actually a sample rather than a coincidence.

The second question is the one that matters. A length prefix that happens to
fall in a plausible range appears roughly once every few kilobytes in
compressed data, so a scanner that only checks lengths will confidently walk
into the middle of a frame. What stops it is reading the header the codec says
should be there and checking that its fields make sense. Getting three
Exp-Golomb fields in a row to land on legal values by chance is rare enough
that the walk stays on the rails for hundreds of thousands of samples.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class VideoSample:
    """One decodable picture, as found in the byte stream."""

    size: int
    is_sync: bool          # can be decoded without anything before it
    poc: int | None        # picture order count: display position within a GOP
    frame_num: int | None
    is_reference: bool = True


@dataclass(frozen=True)
class AudioFrame:
    offset: int
    size: int
    duration: int          # in samples


class VideoCodec:
    """Finds and validates video samples."""

    name = "unknown"
    fourcc = b"----"

    def configure(self, config: bytes) -> None:
        """Take the codec's own configuration record (`avcC`, `hvcC`)."""
        raise NotImplementedError

    def try_sample(
        self, data: bytes, offset: int, limit: int | None = None
    ) -> VideoSample | None:
        """Return the sample starting at `offset`, or None if none does.

        `limit` is where the media ends. Without it a sample can be read as
        running past the end of the media and into whatever follows, which on
        a file that still has part of an index means parsing the index as
        picture data.
        """
        raise NotImplementedError

    @property
    def configured(self) -> bool:
        raise NotImplementedError


class AudioCodec:
    """Splits a run of bytes into frames."""

    name = "unknown"
    fourcc = b"----"
    samples_per_frame = 1024

    def configure(self, config: bytes) -> None:
        raise NotImplementedError

    def segment(self, data: bytes, base_offset: int) -> tuple[list[AudioFrame], int]:
        """Split `data` into frames.

        Returns the frames and the number of bytes that could not be read as
        one. Those bytes are damage, and the count is how the caller finds out
        about it.
        """
        raise NotImplementedError

    @property
    def available(self) -> bool:
        """False when the machine is missing what this needs to run."""
        return True

    @property
    def unavailable_reason(self) -> str:
        return ""
