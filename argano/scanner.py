"""Walking a wall of bytes that has no index.

Inside `mdat` a recorder writes in turns: a run of video frames, then the audio
that belongs beside them, then the next run of video. Nothing marks the
boundaries. The video is self-describing enough to be walked frame by frame, so
the audio is found by subtraction: it is whatever sits between the end of one
video run and the start of the next.

Finding "the start of the next" is the whole problem. Scanning forward for the
first position that reads as a frame is not enough, because a position inside a
frame will sometimes read as one.

How much evidence is available depends on how the file was written, so there
are three tests and the nearest position to satisfy any of them wins.

Several frames back to back is the strongest. Three consecutive slice headers
validating on bytes that are not video effectively does not happen. Recorders
that write video in batches, which includes the one this program was written
for, are settled by this alone.

Some writers interleave far more finely: one frame, a few hundred bytes of
sound, one frame. There, frames are never adjacent and the first test can
never pass. The second one uses the other stream instead. The gap between two
runs of video has to be exactly a whole number of audio frames with nothing
left over, because that is what interleaving means.

After real damage neither holds, since a stretch of noise is not an audio run
and the frames around it are not adjacent. The last test asks whether the
alternation itself resumes: a frame, a short gap, a frame, a short gap, a
frame. Noise does not produce that shape.

Speed matters as much as correctness here. A four kilobyte audio run means
four thousand candidate positions and a fifteen minute recording has two
thousand of those runs, so testing every offset with a full header parse is
minutes of work. Offsets are filtered first with a byte pattern that any real
sample start has to match, and only the survivors are parsed properly.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .codecs.base import VideoCodec

# How many samples in a row have to parse before a restart is believed.
CONFIRM_SAMPLES = 3
# A run of audio shorter than this is not worth calling a run.
MIN_AUDIO_RUN = 24
# Past this, a gap is damage rather than interleaved sound, and checking it
# against the audio decoder for every candidate stops being worth the time.
AUDIO_FIT_LIMIT = 96 << 10
# How far past a run of frames to look for the next one when checking whether
# the interleave has started again. Wide enough for an audio run, narrow enough
# that a false start does not chain its way across the whole file.
CHAIN_GAP = 64 << 10
# Once the weaker evidence has an answer, how much further to look for
# something stronger before settling for it.
STRONGER_LOOKAHEAD = 16 << 10
# A ceiling on the expensive last-resort test, so a stretch of noise cannot
# turn one gap into minutes of work.
MAX_CHAIN_ATTEMPTS = 400
# How far to keep looking after the near tests have given up. Past this the
# honest answer is that no further frames were found.
FAR_SEARCH = 16 << 20


@dataclass
class VideoSampleRecord:
    offset: int
    size: int
    is_sync: bool
    poc: int | None
    frame_num: int | None
    chunk: int
    is_reference: bool = True


@dataclass
class Damage:
    """A stretch of the file that could not be read as anything."""

    offset: int
    length: int
    kind: str
    note: str = ""


@dataclass
class ScanResult:
    video: list[VideoSampleRecord] = field(default_factory=list)
    audio_spans: list[tuple[int, int]] = field(default_factory=list)
    damage: list[Damage] = field(default_factory=list)
    scanned_to: int = 0
    chunks: int = 0

    @property
    def video_bytes(self) -> int:
        return sum(s.size for s in self.video)

    @property
    def audio_bytes(self) -> int:
        return sum(length for _, length in self.audio_spans)

    @property
    def damaged_bytes(self) -> int:
        return sum(d.length for d in self.damage)


def h264_candidate_pattern(nal_length_size: int) -> re.Pattern[bytes]:
    """Byte pattern that every H.264 sample start matches.

    The length comes first and a single frame is never sixteen megabytes, so
    the top byte of a four-byte length is zero. Behind the length sits the NAL
    header, whose top bit is always clear and whose bottom five bits name a
    unit type that exists. Together that rejects about 99.6 percent of offsets
    before any parsing happens.
    """
    from .codecs.h264 import KNOWN_TYPES

    header_bytes = {
        (ref << 5) | nal_type for ref in range(4) for nal_type in KNOWN_TYPES
    }
    return _build_pattern(nal_length_size, header_bytes, header_len=1)


def hevc_candidate_pattern(nal_length_size: int) -> re.Pattern[bytes]:
    from .codecs.hevc import KNOWN_TYPES

    header_bytes = {nal_type << 1 for nal_type in KNOWN_TYPES}
    return _build_pattern(nal_length_size, header_bytes, header_len=1)


def _build_pattern(
    nal_length_size: int, header_bytes: set[int], header_len: int
) -> re.Pattern[bytes]:
    charclass = b"[" + b"".join(
        re.escape(bytes([b])) for b in sorted(header_bytes)
    ) + b"]"
    if nal_length_size >= 3:
        lead = re.escape(b"\x00") + b"[\\x00-\\xff]{%d}" % (nal_length_size - 1)
    else:
        lead = b"[\\x00-\\xff]{%d}" % nal_length_size
    # Zero width, so the search does not consume what it matched. A plain match
    # is five bytes long and scanning resumes after it, which silently hides
    # any genuine sample start inside those five bytes. That is not a rare
    # case: one false match two bytes before a real one loses the rest of the
    # recording.
    return re.compile(b"(?=" + lead + charclass + b")", re.DOTALL)


def candidate_pattern_for(codec: VideoCodec) -> re.Pattern[bytes]:
    if codec.name == "hevc":
        return hevc_candidate_pattern(codec.nal_length_size)
    return h264_candidate_pattern(codec.nal_length_size)


class MediaScanner:
    """Segments a media region into video samples and audio runs."""

    def __init__(
        self,
        data: bytes,
        video_codec: VideoCodec | None,
        has_audio: bool,
        confirm: int = CONFIRM_SAMPLES,
        audio_boundaries=None,
    ) -> None:
        self.data = data
        self.codec = video_codec
        self.has_audio = has_audio
        self.confirm = confirm
        # Lists the offsets where audio frames end, walking forward from a
        # point. Optional, and the scan is much better at fine interleaving
        # when it is there. See `_find_restart`.
        self.audio_boundaries = audio_boundaries
        self._pattern = candidate_pattern_for(video_codec) if video_codec else None

    def scan(self, start: int, end: int, progress=None) -> ScanResult:
        result = ScanResult()
        if self.codec is None:
            result.audio_spans.append((start, end - start))
            result.scanned_to = end
            return result

        pos = start
        chunk = 0
        last_report = start

        while pos < end:
            run_start = pos
            count = 0
            while pos < end:
                sample = self.codec.try_sample(self.data, pos, end)
                if sample is None:
                    break
                result.video.append(
                    VideoSampleRecord(
                        offset=pos,
                        size=sample.size,
                        is_sync=sample.is_sync,
                        poc=sample.poc,
                        frame_num=sample.frame_num,
                        chunk=chunk,
                        is_reference=sample.is_reference,
                    )
                )
                pos += sample.size
                count += 1

            if count:
                chunk += 1
            if progress is not None and pos - last_report > (8 << 20):
                progress(pos - start, end - start)
                last_report = pos

            if pos >= end:
                break

            # Not on a video sample. Whatever follows is either the audio that
            # belongs beside the run we just read, or damage.
            gap_start = pos
            next_video = self._find_restart(pos + 1, end, gap_start)

            if next_video is None:
                tail = end - gap_start
                if self.has_audio and tail > 0:
                    result.audio_spans.append((gap_start, tail))
                elif tail > 0:
                    result.damage.append(
                        Damage(gap_start, tail, "unreadable-tail",
                               "no further video samples could be found")
                    )
                pos = end
                break

            span = next_video - gap_start
            if count == 0 and not result.video:
                # The file opens with something other than video. Common when
                # the first thing written is an audio run.
                result.audio_spans.append((gap_start, span))
            elif self.has_audio and span >= MIN_AUDIO_RUN:
                result.audio_spans.append((gap_start, span))
            else:
                result.damage.append(
                    Damage(gap_start, span, "garbage",
                           "bytes between two video runs that read as neither")
                )
            pos = next_video

        result.scanned_to = pos
        result.chunks = chunk
        return result

    def _find_restart(self, start: int, end: int, gap_start: int) -> int | None:
        """Where the video picks up again after a run of something else.

        Three tests, and the nearest position that satisfies any of them wins.
        Nearest matters: taking the first position anywhere in the file that
        passes the strongest test will happily skip half a recording to reach
        it, and every frame in between gets reported as damage.

        Several frames back to back is the strong test. Three consecutive slice
        headers validating on bytes that are not video effectively does not
        happen, and where a recorder writes video in batches this settles it.

        Finely interleaved files never have two frames adjacent, so the second
        test uses the other stream: the gap has to be exactly a whole number of
        audio frames, with nothing left over.

        After real damage neither holds, and the third asks whether the
        alternation itself resumes.

        The search runs in widening windows rather than straight to the end of
        the file. Almost every restart is a few kilobytes away, and scanning
        hundreds of megabytes to prove that a damaged stretch has no restart in
        it costs minutes per occurrence.
        """
        assert self._pattern is not None
        for window, thorough in self._windows(gap_start, start, end):
            found = self._search(start, window, end, gap_start, thorough)
            if found is not None:
                return found
        return None

    def _windows(self, gap_start: int, start: int, end: int) -> list[tuple[int, bool]]:
        """Widening bounds for the search, nearest first, with what to spend.

        Almost every restart is inside the first bound, which is the width of a
        plausible interleaved run. Keeping that first look tight is what stops
        weaker evidence a few hundred bytes away from beating the strong
        evidence just behind it.

        Past the second bound only the cheap test runs. Asking for several
        frames in a row across thirty megabytes means a hundred thousand header
        parses, and it is asked once per gap: on a recording with fifteen
        thousand gaps that is the difference between a minute and an afternoon.
        The far search is for damage, and the pattern test is the one that
        answers for damage anyway.
        """
        bounds = [
            (min(gap_start + AUDIO_FIT_LIMIT, end), True),
            (min(start + (1 << 20), end), True),
            (min(start + FAR_SEARCH, end), False),
        ]
        out: list[tuple[int, bool]] = []
        for bound, thorough in bounds:
            if bound > start and (not out or bound > out[-1][0]):
                out.append((bound, thorough))
        return out

    def _search(
        self, start: int, window: int, end: int, gap_start: int, thorough: bool = True
    ) -> int | None:
        """Earliest restart in [start, window), strongest evidence first.

        The order matters. All three tests can be true at once, and the weaker
        ones are true by accident more often than they should be: a position
        that happens to sit on an audio frame boundary satisfies the second
        test, and a few of those also read as a single frame. Letting that win
        over several frames back to back a little further on is how a scan
        walks into the middle of a run and reports the rest as damage.
        """
        fitted = None
        if thorough:
            fitted = self._audio_answer(gap_start, min(window, gap_start + AUDIO_FIT_LIMIT), end)
            limit = window if fitted is None else min(window, fitted + STRONGER_LOOKAHEAD)
            for match in self._pattern.finditer(self.data, start, limit):
                offset = match.start()
                if self._consecutive(offset, end) >= self.confirm:
                    return offset
            if fitted is not None:
                return fitted

        attempts = 0
        for match in self._pattern.finditer(self.data, start, window):
            offset = match.start()
            # The chain test is the expensive one, so it is only asked about
            # positions that at least read as a single frame, and only so many
            # times before the search widens instead.
            if self.codec.try_sample(self.data, offset, end) is None:
                continue
            attempts += 1
            if attempts > MAX_CHAIN_ATTEMPTS:
                break
            if self._chain(offset, end) >= self.confirm:
                return offset
        return None

    def _audio_answer(self, gap_start: int, limit: int, end: int) -> int | None:
        """Where the run of sound ends, according to the sound itself.

        A gap between two runs of video is a whole number of audio frames,
        because that is what interleaving means. Walking those frames once and
        stopping at the first boundary that also reads as a video sample
        answers the question in one pass over the gap.
        """
        if self.audio_boundaries is None or limit <= gap_start:
            return None
        for boundary in self.audio_boundaries(gap_start, limit):
            if boundary <= gap_start or boundary >= end:
                break
            if self.codec.try_sample(self.data, boundary, end) is not None:
                return boundary
        return None

    def _chain(self, offset: int, end: int) -> int:
        """Frames reachable from here across a few runs of the interleave."""
        pos = offset
        samples = 0
        for _ in range(self.confirm):
            found = 0
            while found < 4:
                sample = self.codec.try_sample(self.data, pos, end)
                if sample is None:
                    break
                pos += sample.size
                found += 1
            if found == 0:
                break
            samples += found
            if samples >= self.confirm or pos >= end:
                break
            following = self._next_parsable(pos + 1, min(end, pos + CHAIN_GAP))
            if following is None:
                break
            pos = following
        return samples

    def _next_parsable(self, start: int, end: int) -> int | None:
        for match in self._pattern.finditer(self.data, start, end):
            if self.codec.try_sample(self.data, match.start(), end) is not None:
                return match.start()
        return None

    def _consecutive(self, offset: int, end: int) -> int:
        """How many samples parse back to back from here, up to what we need."""
        pos = offset
        found = 0
        while found < self.confirm:
            if pos >= end:
                break
            sample = self.codec.try_sample(self.data, pos, end)
            if sample is None:
                break
            pos += sample.size
            found += 1
        if pos >= end and found:
            # Running out of file is not a failure. The last run of a
            # recording is usually short.
            return self.confirm
        return found


def find_parameter_sets(data: bytes, codec: VideoCodec, limit: int = 64 << 20) -> int:
    """Harvest in-band SPS and PPS so a file can be read without a reference.

    Encoders that repeat their parameter sets in the stream make a second file
    unnecessary. Photo Booth is not one of them, phone cameras usually are.
    Returns how many sets were taken.
    """
    if codec.name == "hevc":
        wanted = {33, 34}

        def type_of(byte0: int, byte1: int) -> int:
            return (byte0 >> 1) & 0x3F
    else:
        wanted = {7, 8}

        def type_of(byte0: int, byte1: int) -> int:
            return byte0 & 0x1F

    before = len(getattr(codec, "sps", {})) + len(getattr(codec, "pps", {}))
    ls = codec.nal_length_size
    window = min(len(data), limit)

    # A parameter set is a few dozen bytes, so all but the last byte of its
    # length are zero. That plus the header byte is a pattern the regex engine
    # can sweep at C speed, which matters when the window is tens of megabytes.
    if codec.name == "hevc":
        header_bytes = {nal_type << 1 for nal_type in wanted}
    else:
        header_bytes = {(ref << 5) | nal_type for ref in range(4) for nal_type in wanted}
    charclass = b"[" + b"".join(re.escape(bytes([b])) for b in sorted(header_bytes)) + b"]"
    pattern = re.compile(b"\\x00" * (ls - 1) + b"[\\x04-\\xff]" + charclass, re.DOTALL)

    # Random data matches this pattern too, and a fabricated parameter set that
    # overwrites the real one makes every genuine frame afterwards fail to
    # validate. An encoder that repeats its settings repeats them identically
    # before every keyframe, so the same bytes turning up more than once is the
    # thing that separates a real set from a coincidence.
    seen: Counter[bytes] = Counter()
    for match in pattern.finditer(data, 0, window):
        pos = match.start()
        length = int.from_bytes(data[pos : pos + ls], "big")
        seen[bytes(data[pos + ls : pos + ls + length])] += 1

    repeated = [nal for nal, count in seen.most_common() if count > 1]
    for nal in repeated or list(seen):
        codec.add_parameter_set(nal)

    after = len(getattr(codec, "sps", {})) + len(getattr(codec, "pps", {}))
    return after - before
