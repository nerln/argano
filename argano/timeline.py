"""Putting the frames back on a clock.

The samples come out of the scan in the order they were written, and that is
all the scan can know. When each one should appear is recorded nowhere in the
media, because it lived in the index.

Guessing a frame rate and multiplying is the obvious move and it is wrong for
anything a phone or a screen recorder produced. Those write variable rate
video: the interval between frames moves with the scene, and a constant rate
laid over fifteen minutes of it drifts far enough that the picture and the
sound visibly part company well before the end.

The audio is the better clock. Every compressed audio frame is a fixed number
of samples, so counting the frames in a run gives its exact duration, with no
estimate involved. A recorder interleaves the two streams as it goes, which
means the audio written between two runs of video measures the wall-clock time
those frames occupied. Anchoring each run of video to the audio beside it keeps
the two together for as long as the recording lasts, and the frames inside a
run only have to be spread across a window that is half a second wide.

Display order is the second half of the job. Encoders reorder frames so that a
frame can be predicted from one that comes after it on screen, and the order to
show them in is written in each frame's own header as a picture order count.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .scanner import ScanResult, VideoSampleRecord


@dataclass
class VideoTiming:
    timescale: int
    dts: list[int] = field(default_factory=list)
    durations: list[int] = field(default_factory=list)
    ctts: list[int] = field(default_factory=list)
    sync_samples: list[int] = field(default_factory=list)   # 1-based
    presentation_delay: int = 0
    model: str = ""

    @property
    def duration(self) -> int:
        return (self.dts[-1] + self.durations[-1]) if self.dts else 0


@dataclass
class AudioTiming:
    timescale: int
    frame_durations: list[int] = field(default_factory=list)
    encoder_delay: int = 0

    @property
    def duration(self) -> int:
        return sum(self.frame_durations)


def unwrap_picture_order(
    samples: list[VideoSampleRecord], max_poc_lsb: int
) -> list[int]:
    """Turn the per-frame order counts into a display rank for each frame.

    The count in a frame header is truncated: it counts up and wraps, and the
    top half of the number is left for the decoder to track. The rule for
    recovering it is the one from the standard. A count that drops sharply has
    wrapped upward, one that jumps sharply belongs to the previous cycle, and a
    keyframe resets the whole thing.

    Frames with no count at all, which is what a stream with no reordering
    produces, keep the order they were written in.
    """
    n = len(samples)
    if n == 0:
        return []
    if max_poc_lsb <= 0 or all(s.poc is None for s in samples):
        return list(range(n))

    half = max_poc_lsb // 2
    ranks = [0] * n
    group_start = 0
    next_rank = 0

    def close_group(start: int, stop: int, order: list[tuple[int, int]]) -> None:
        nonlocal next_rank
        order.sort()
        for position, (_, index) in enumerate(order):
            ranks[index] = next_rank + position
        next_rank += len(order)

    order: list[tuple[int, int]] = []
    prev_lsb = 0
    prev_msb = 0
    for i, sample in enumerate(samples):
        if sample.is_sync and i > group_start:
            close_group(group_start, i, order)
            order = []
            group_start = i
            prev_lsb = prev_msb = 0

        lsb = sample.poc
        if lsb is None:
            # No count to sort by. Keep the frame where it was written by
            # giving it a value just past the last one used.
            full = prev_msb + prev_lsb + 1
        else:
            if sample.is_sync and i == group_start:
                msb = 0
                prev_lsb = 0
            elif lsb < prev_lsb and (prev_lsb - lsb) >= half:
                msb = prev_msb + max_poc_lsb
            elif lsb > prev_lsb and (lsb - prev_lsb) > half:
                msb = prev_msb - max_poc_lsb
            else:
                msb = prev_msb
            full = msb + lsb
            if sample.is_reference:
                prev_msb = msb
                prev_lsb = lsb
        order.append((full, i))

    close_group(group_start, n, order)
    return ranks


def audio_anchored_slots(
    scan: ScanResult,
    audio_samples_per_span: list[int],
    timescale: int,
) -> tuple[list[int], str]:
    """One presentation instant per video frame, measured by the audio beside it.

    Each run of video is given the stretch of time that the audio written
    before the next run accounts for, and the frames in the run are spread
    evenly across it. Nothing here needs to know the frame rate.
    """
    if not scan.video:
        return [], "no video"

    # Where each audio run sits, and how much time it accounts for.
    spans = [
        (offset, length, samples)
        for (offset, length), samples in zip(scan.audio_spans, audio_samples_per_span)
    ]
    spans.sort()

    # Time on the clock before a given file offset.
    boundaries: list[tuple[int, int]] = []
    running = 0
    for offset, _length, samples in spans:
        boundaries.append((offset, running))
        running += samples
    total_audio = running

    chunk_first_offset: dict[int, int] = {}
    chunk_count: dict[int, int] = {}
    for sample in scan.video:
        chunk_first_offset.setdefault(sample.chunk, sample.offset)
        chunk_count[sample.chunk] = chunk_count.get(sample.chunk, 0) + 1

    def clock_at(offset: int) -> int:
        """Audio samples written before this point in the file."""
        low, high = 0, len(boundaries)
        while low < high:
            mid = (low + high) // 2
            if boundaries[mid][0] < offset:
                low = mid + 1
            else:
                high = mid
        if low == 0:
            return 0
        return boundaries[low - 1][1] + (
            spans[low - 1][2] if low <= len(spans) else 0
        )

    chunks = sorted(chunk_first_offset)
    starts: dict[int, int] = {}
    for chunk in chunks:
        starts[chunk] = clock_at(chunk_first_offset[chunk])

    slots: list[int] = []
    average = 0
    for position, chunk in enumerate(chunks):
        count = chunk_count[chunk]
        begin = starts[chunk]
        if position + 1 < len(chunks):
            finish = starts[chunks[position + 1]]
        else:
            finish = max(total_audio, begin + (average * count if average else count * 1470))
        width = finish - begin
        if width <= 0:
            width = (average or 1470) * count
        for index in range(count):
            slots.append(begin + (index * width) // count)
        if count:
            average = width // count

    slots = _make_strictly_increasing(slots)
    return slots, "audio-anchored"


def fixed_rate_slots(count: int, timescale: int, fps: float) -> tuple[list[int], str]:
    """Even spacing at a nominal rate, for when there is no audio to anchor to."""
    step = timescale / fps
    return [round(i * step) for i in range(count)], f"fixed {fps:g} fps"


def _make_strictly_increasing(values: list[int]) -> list[int]:
    """Decode timestamps have to keep going up, and a muxer will refuse them otherwise."""
    out: list[int] = []
    last = -1
    for value in values:
        if value <= last:
            value = last + 1
        out.append(value)
        last = value
    return out


def build_video_timing(
    samples: list[VideoSampleRecord],
    slots: list[int],
    ranks: list[int],
    timescale: int,
    model: str,
) -> VideoTiming:
    """Turn instants and display ranks into the tables an index is made of.

    Presentation offsets are kept at or above zero and the whole track is
    started a little late to pay for it, which is expressed as an edit. The
    alternative, letting the first frames carry negative decode times, is legal
    and is what QuickTime itself writes, and it is also what several players
    and at least one large video site handle worst.
    """
    n = len(samples)
    timing = VideoTiming(timescale=timescale, model=model)
    if n == 0:
        return timing

    presentation = [slots[ranks[i]] for i in range(n)]
    delay = max((slots[i] - presentation[i] for i in range(n)), default=0)
    delay = max(delay, 0)

    timing.dts = list(slots[:n])
    timing.ctts = [presentation[i] + delay - slots[i] for i in range(n)]
    timing.presentation_delay = delay

    durations = [slots[i + 1] - slots[i] for i in range(n - 1)]
    tail = durations[-1] if durations else max(1, timescale // 30)
    durations.append(tail)
    timing.durations = durations

    timing.sync_samples = [i + 1 for i, s in enumerate(samples) if s.is_sync]
    return timing
