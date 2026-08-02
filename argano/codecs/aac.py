"""AAC, and the reason recovering the sound is harder than recovering the picture.

A video sample announces its own length. An AAC frame does not. Inside an MP4
the frames are stored raw, with no sync word and no length field, because the
index was supposed to hold the sizes and the index is what is missing. The only
thing that knows where one frame ends is a decoder that has read it, so the
segmentation here runs a real decoder and takes the byte count it reports.

Two things about that turn out to matter.

The first is that a decoder handed damaged bytes does not just fail on them, it
stays failed. Its internal state carries prediction and windowing from the
previous frame, and once that state has absorbed nonsense every frame after it
decodes wrong, silently, with no error. Segmenting a long recording with one
long-lived decoder gives you a few hundred frames and then a wall. Opening a
fresh decoder for each run of audio, and again after every error, is what turns
that few hundred back into all of them.

The second is that a decoder is expensive to ask a question a hundred thousand
times, which is what resynchronising after damage costs if every byte offset is
a candidate. So the offsets are filtered first by the top three bits, which name
the kind of element the frame opens with. The set of values that count as
plausible is not hardcoded: it is learned from the frames that already decoded
cleanly in this same file, so a stream that opens its frames some other way
still resynchronises.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
from collections import Counter

from .base import AudioCodec, AudioFrame

# Where a package manager puts libfaad, in the order worth trying.
LIBRARY_CANDIDATES = (
    "libfaad.so.2",
    "libfaad.so",
    "libfaad.2.dylib",
    "libfaad.dylib",
    "/opt/homebrew/lib/libfaad.dylib",
    "/usr/local/lib/libfaad.dylib",
    "/usr/lib/x86_64-linux-gnu/libfaad.so.2",
    "/usr/lib/aarch64-linux-gnu/libfaad.so.2",
)

INSTALL_HINT = (
    "install faad2: `brew install faad2` on macOS, "
    "`apt install libfaad2` on Debian or Ubuntu"
)


class _FrameInfo(ctypes.Structure):
    """NeAACDecFrameInfo. Only the first fields are read, and they are stable."""

    _fields_ = [
        ("bytesconsumed", ctypes.c_ulong),
        ("samples", ctypes.c_ulong),
        ("channels", ctypes.c_ubyte),
        ("error", ctypes.c_ubyte),
        ("samplerate", ctypes.c_ulong),
        ("sbr", ctypes.c_ubyte),
        ("object_type", ctypes.c_ubyte),
        ("header_type", ctypes.c_ubyte),
        ("num_front_channels", ctypes.c_ubyte),
        ("num_side_channels", ctypes.c_ubyte),
        ("num_back_channels", ctypes.c_ubyte),
        ("num_lfe_channels", ctypes.c_ubyte),
        ("channel_position", ctypes.c_ubyte * 64),
        ("ps", ctypes.c_ubyte),
        # faad2 has grown fields at the end between releases. The padding keeps
        # a newer library from writing past what we allocated.
        ("_tail", ctypes.c_ubyte * 128),
    ]


_library = None
_load_error = ""


def _load_library():
    global _library, _load_error
    if _library is not None or _load_error:
        return _library

    names = list(LIBRARY_CANDIDATES)
    found = ctypes.util.find_library("faad")
    if found:
        names.insert(0, found)
    override = os.environ.get("ARGANO_LIBFAAD")
    if override:
        names.insert(0, override)

    for name in names:
        try:
            lib = ctypes.CDLL(name)
        except OSError:
            continue
        try:
            lib.NeAACDecOpen.restype = ctypes.c_void_p
            lib.NeAACDecInit2.restype = ctypes.c_char
            lib.NeAACDecInit2.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_ubyte),
                ctypes.c_ulong,
                ctypes.POINTER(ctypes.c_ulong),
                ctypes.POINTER(ctypes.c_ubyte),
            ]
            lib.NeAACDecDecode.restype = ctypes.c_void_p
            lib.NeAACDecDecode.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(_FrameInfo),
                ctypes.POINTER(ctypes.c_ubyte),
                ctypes.c_ulong,
            ]
            lib.NeAACDecClose.argtypes = [ctypes.c_void_p]
        except AttributeError:
            continue
        _library = lib
        return lib

    _load_error = f"libfaad was not found on this machine, {INSTALL_HINT}"
    return None


class _Decoder:
    """One libfaad instance, opened against a known audio configuration."""

    def __init__(self, lib, asc: bytes) -> None:
        self._lib = lib
        self._handle = lib.NeAACDecOpen()
        if not self._handle:
            raise RuntimeError("libfaad would not open a decoder")
        buf = (ctypes.c_ubyte * len(asc)).from_buffer_copy(asc)
        rate = ctypes.c_ulong(0)
        channels = ctypes.c_ubyte(0)
        result = lib.NeAACDecInit2(
            self._handle, buf, len(asc), ctypes.byref(rate), ctypes.byref(channels)
        )
        if result != b"\x00":
            self.close()
            raise ValueError("libfaad rejected the audio configuration record")
        self.sample_rate = rate.value
        self.channels = channels.value

    def decode(self, data: bytes, offset: int, length: int) -> tuple[int, int, int]:
        """`(bytes_consumed, samples_per_channel, error_code)` for the frame at `offset`.

        The count libfaad reports is every sample it produced, across all
        channels. A track's duration is measured per channel, so a stereo frame
        reported as 2048 is 1024 long. Taking the raw number makes the file
        claim twice the running time it has, which is not obvious until the
        sound finishes halfway through the picture.
        """
        info = _FrameInfo()
        buf = (ctypes.c_ubyte * length).from_buffer_copy(data[offset : offset + length])
        self._lib.NeAACDecDecode(self._handle, ctypes.byref(info), buf, length)
        channels = max(1, int(info.channels))
        return int(info.bytesconsumed), int(info.samples) // channels, int(info.error)

    def close(self) -> None:
        if getattr(self, "_handle", None):
            self._lib.NeAACDecClose(self._handle)
            self._handle = None

    def __del__(self) -> None:
        self.close()


class AacCodec(AudioCodec):
    name = "aac"
    fourcc = b"mp4a"
    samples_per_frame = 1024

    def __init__(self) -> None:
        self._asc = b""
        self._element_types: Counter[int] = Counter()

    @property
    def available(self) -> bool:
        return _load_library() is not None

    @property
    def unavailable_reason(self) -> str:
        _load_library()
        return _load_error

    def configure(self, config: bytes) -> None:
        """Take the AudioSpecificConfig out of the `esds` box, or the raw bytes."""
        if not config:
            raise ValueError("empty audio configuration")
        self._asc = extract_audio_specific_config(config)
        self.samples_per_frame = frame_length_from_config(self._asc)

    @property
    def sample_rate(self) -> int:
        lib = _load_library()
        if lib is None or not self._asc:
            return 0
        try:
            decoder = _Decoder(lib, self._asc)
        except (ValueError, RuntimeError):
            return 0
        rate = decoder.sample_rate
        decoder.close()
        return rate

    def segment(self, data: bytes, base_offset: int) -> tuple[list[AudioFrame], int]:
        lib = _load_library()
        if lib is None:
            raise RuntimeError(self.unavailable_reason)
        if not self._asc:
            raise RuntimeError("the audio configuration has not been set")

        frames: list[AudioFrame] = []
        skipped = 0
        decoder = _Decoder(lib, self._asc)
        pos = 0
        size = len(data)
        try:
            while pos < size:
                consumed, samples, error = decoder.decode(data, pos, size - pos)
                if error == 0 and consumed > 0:
                    frames.append(
                        AudioFrame(base_offset + pos, consumed, self.samples_per_frame)
                    )
                    self._element_types[data[pos] >> 5] += 1
                    pos += consumed
                    continue

                # Damage. Reopen, because this decoder's state is now worthless,
                # and step forward to the next offset that could open a frame.
                decoder.close()
                step = self._next_candidate(data, pos + 1)
                skipped += step - pos
                pos = step
                if pos >= size:
                    break
                decoder = _Decoder(lib, self._asc)
        finally:
            decoder.close()
        return frames, skipped

    def boundaries(self, data: bytes, start: int, limit: int):
        lib = _load_library()
        if lib is None or not self._asc:
            return
        decoder = _Decoder(lib, self._asc)
        try:
            pos = start
            while pos < limit:
                consumed, _samples, error = decoder.decode(data, pos, limit - pos)
                if error != 0 or consumed <= 0:
                    return
                pos += consumed
                yield pos
        finally:
            decoder.close()

    def _next_candidate(self, data: bytes, start: int) -> int:
        """Next offset whose first element type matches what this file uses."""
        allowed = {value for value, count in self._element_types.items() if count > 4}
        if not allowed:
            return start
        pos = start
        size = len(data)
        while pos < size:
            if (data[pos] >> 5) in allowed:
                return pos
            pos += 1
        return size


def frame_length_from_config(asc: bytes) -> int:
    """How many samples one frame lasts, from the configuration record.

    The decoder's own count cannot be used for this. A decoder produces nothing
    for the first frame it is given, because that frame only fills the overlap
    window that the next one is added into, so it reports zero samples. With a
    fresh decoder opened for every run of audio, that is one frame's worth of
    duration lost per run, and a fifteen minute recording quietly comes out
    half a minute short with every frame still present and correct.

    The length is a property of the encoding, stated once: 1024 samples, or 960
    for the variant some low-delay encoders use.
    """
    from ..bitreader import BitReader, BitstreamError

    if len(asc) < 2:
        return 1024
    try:
        r = BitReader(asc)
        object_type = r.u(5)
        if object_type == 31:
            object_type = 32 + r.u(6)
        frequency_index = r.u(4)
        if frequency_index == 15:
            r.u(24)
        r.u(4)  # channelConfiguration
        if object_type in (5, 29):
            # Explicit spectral band replication: the base configuration this
            # needs sits behind the extension.
            if r.u(4) == 15:
                r.u(24)
            object_type = r.u(5)
            if object_type == 31:
                object_type = 32 + r.u(6)
        if object_type in (1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23):
            return 960 if r.u(1) else 1024
    except (BitstreamError, IndexError):
        pass
    return 1024


def extract_audio_specific_config(config: bytes) -> bytes:
    """Find the AudioSpecificConfig inside an `esds` box.

    `esds` is MPEG-4 descriptor soup: nested tag-length-value records where the
    length is written in up to four continuation bytes. The configuration we
    want is the DecoderSpecificInfo, tag 0x05, and it is usually two bytes.
    Anything that is already two to eight loose bytes is taken as the config
    itself, which is what a caller passing a raw record will hand over.
    """
    if len(config) <= 8 and len(config) >= 2:
        return config

    pos = 0
    # Skip the version and flags of the full box when they are still attached.
    if len(config) > 4 and config[0] == 0 and config[1] == 0 and config[2] == 0:
        pos = 4

    while pos < len(config):
        tag = config[pos]
        pos += 1
        length = 0
        for _ in range(4):
            if pos >= len(config):
                return b""
            byte = config[pos]
            pos += 1
            length = (length << 7) | (byte & 0x7F)
            if not (byte & 0x80):
                break
        if tag == 0x05:  # DecoderSpecificInfo
            return config[pos : pos + length]
        if tag == 0x03:  # ES_Descriptor, step into it
            if pos + 3 > len(config):
                return b""
            flags = config[pos + 2]
            pos += 3
            if flags & 0x80:
                pos += 2
            if flags & 0x40:
                pos += 1 + (config[pos] if pos < len(config) else 0)
            if flags & 0x20:
                pos += 2
            continue
        if tag == 0x04:  # DecoderConfigDescriptor, step into it
            pos += 13
            continue
        pos += length
    return b""


def frame_is_plausible(data: bytes, offset: int, size: int, channels: int = 0) -> bool:
    """A cheap syntax check on top of what the decoder accepted.

    Inside a damaged run, some byte sequences decode without complaint and are
    still not frames. libfaad is forgiving about combinations the format does
    not allow, and a frame it waves through can make a stricter decoder later
    refuse the whole file. The three things checked here are the ones that
    actually turned up: a reserved bit that has to be zero, a band count past
    what the format defines, and prediction, which does not exist in the
    profile every recorder uses.
    """
    from ..bitreader import BitReader, BitstreamError

    if size < 2:
        return False
    try:
        r = BitReader(data[offset : offset + min(size, 12)])
        element = r.u(3)
        if element == 7:            # END on its own is not a frame
            return False
        if element in (4, 5, 6):    # data, program config, fill: no picture of the audio
            return True
        if element == 2:            # coupling channels are not what a recorder writes
            return False
        if channels == 1 and element == 1:
            return False
        if channels == 2 and element == 0:
            return False

        r.u(4)                      # element_instance_tag
        if element == 1:            # channel pair
            if not r.u(1):          # common_window
                return True         # the rest is per-channel, nothing cheap left to check
        r.u(8)                      # global_gain
        if r.u(1):                  # ics_reserved_bit, defined as zero
            return False
        window_sequence = r.u(2)
        r.u(1)                      # window_shape
        if window_sequence == 2:    # eight short windows
            max_sfb = r.u(4)
            if max_sfb > 15:
                return False
            r.u(7)                  # scale_factor_grouping
        else:
            max_sfb = r.u(6)
            if max_sfb > 51:
                return False
            if r.u(1):              # predictor_data_present
                return False        # the LC profile does not have it
        return True
    except (BitstreamError, IndexError):
        return False


class PcmCodec(AudioCodec):
    """Uncompressed audio, where every frame is the same size.

    No decoder is needed to find the boundaries, so this path works everywhere
    and is the fallback when a recording turns out not to be compressed.
    """

    name = "pcm"
    fourcc = b"sowt"
    samples_per_frame = 1

    def __init__(self, bytes_per_sample: int = 2, channels: int = 1) -> None:
        self.frame_size = max(1, bytes_per_sample * channels)

    def configure(self, config: bytes) -> None:
        return

    def boundaries(self, data: bytes, start: int, limit: int):
        pos = start + self.frame_size
        while pos <= limit:
            yield pos
            pos += self.frame_size

    def segment(self, data: bytes, base_offset: int) -> tuple[list[AudioFrame], int]:
        count = len(data) // self.frame_size
        frames = [
            AudioFrame(base_offset + i * self.frame_size, self.frame_size, 1)
            for i in range(count)
        ]
        return frames, len(data) - count * self.frame_size
