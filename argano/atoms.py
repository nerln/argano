"""Reading and writing the box structure of MP4 and QuickTime files.

An MP4 file is a tree of boxes, each one a 4-byte length, a 4-byte name, then
its content. Two boxes carry everything: `mdat` holds the encoded audio and
video, and `moov` holds the index that says where each frame starts, how long
it lasts and what order to show it in. Lose `moov` and the media is intact but
nothing can play it.

The parser here is written to survive files that are wrong, because those are
the only files this program is ever handed. A length that runs past the end of
the file is reported rather than raised, and the walk stops where the damage
starts instead of throwing away everything found so far.

The builder is the other half, and it is deliberately strict. A box written
four bytes too long still parses, and players that read fields by name will
often still show a picture, so the mistake survives every casual check and
then breaks on the players that read fields by offset. Every fixed-layout box
built here is checked against its known size before it goes anywhere.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import BinaryIO, Iterator

# Boxes whose content is more boxes. Anything not in here is a leaf and its
# bytes are left alone.
CONTAINER_TYPES = frozenset(
    {
        b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf",
        b"udta", b"moof", b"traf", b"mvex", b"skip", b"meta", b"ipro",
        b"sinf", b"schi", b"tapt", b"wave", b"gmhd",
    }
)

# The sizes a correctly built box has to have. This is the table that catches
# an off-by-four in a header before it reaches a user.
FIXED_SIZES = {
    (b"tkhd", 0): 92,
    (b"tkhd", 1): 104,
    (b"mdhd", 0): 32,
    (b"mdhd", 1): 44,
    (b"mvhd", 0): 108,
    (b"mvhd", 1): 120,
    (b"vmhd", 0): 20,
    (b"smhd", 0): 16,
    (b"hdlr", 0): None,   # trailing name string, length is free
}


class ContainerError(ValueError):
    """The box structure does not hold up."""


@dataclass
class Box:
    """One box, and where in the file it was found."""

    type: bytes
    offset: int          # of the box header
    size: int            # total, header included
    header_size: int     # 8, or 16 when the length is 64-bit
    children: list["Box"] = field(default_factory=list)
    truncated: bool = False   # its length runs past the end of the file

    @property
    def payload_offset(self) -> int:
        return self.offset + self.header_size

    @property
    def payload_size(self) -> int:
        return self.size - self.header_size

    @property
    def end(self) -> int:
        return self.offset + self.size

    @property
    def name(self) -> str:
        return self.type.decode("latin-1")

    def find(self, path: str) -> "Box | None":
        """First descendant at a slash-separated path, e.g. `mdia/minf/stbl`."""
        node = self
        for part in path.split("/"):
            want = part.encode("latin-1")
            for child in node.children:
                if child.type == want:
                    node = child
                    break
            else:
                return None
        return node

    def find_all(self, type_: str) -> list["Box"]:
        """Every descendant of a type, in document order."""
        want = type_.encode("latin-1")
        out: list[Box] = []
        stack = list(self.children)
        while stack:
            node = stack.pop(0)
            if node.type == want:
                out.append(node)
            stack = node.children + stack
        return out

    def walk(self) -> Iterator["Box"]:
        yield self
        for child in self.children:
            yield from child.walk()


def parse_boxes(fh: BinaryIO, start: int, end: int, depth: int = 0) -> list[Box]:
    """Walk the boxes in [start, end), stopping at the first thing that is wrong.

    Returning what was read rather than raising is the point. A file whose last
    box is a truncated `mdat` still has a usable `ftyp` before it, and the
    caller needs to see that.
    """
    boxes: list[Box] = []
    offset = start
    while offset + 8 <= end:
        fh.seek(offset)
        header = fh.read(8)
        if len(header) < 8:
            break
        size = struct.unpack(">I", header[:4])[0]
        type_ = header[4:8]
        header_size = 8

        if size == 1:
            extra = fh.read(8)
            if len(extra) < 8:
                break
            size = struct.unpack(">Q", extra)[0]
            header_size = 16
        elif size == 0:
            # "To the end of the file", which is how an unfinalised recording
            # leaves its mdat: the writer never went back to fill the length in.
            size = end - offset

        if size < header_size:
            break
        if not _plausible_type(type_):
            break

        box = Box(type=type_, offset=offset, size=size, header_size=header_size)
        if box.end > end:
            box.truncated = True
            box.size = end - offset

        if type_ in CONTAINER_TYPES and depth < 12 and not box.truncated:
            box.children = parse_boxes(fh, box.payload_offset, box.end, depth + 1)

        boxes.append(box)
        if box.truncated:
            break
        offset = box.end
    return boxes


def _plausible_type(type_: bytes) -> bool:
    """A box name is four printable characters. Anything else is not a box."""
    return all(0x20 <= c <= 0x7E for c in type_)


def read_box_payload(fh: BinaryIO, box: Box) -> bytes:
    fh.seek(box.payload_offset)
    return fh.read(box.payload_size)


# --- building ---------------------------------------------------------------


def box(type_: bytes, payload: bytes) -> bytes:
    """A box with a 32-bit length."""
    total = 8 + len(payload)
    if total >= 1 << 32:
        raise ContainerError(f"{type_.decode()} is too large for a 32-bit length")
    return struct.pack(">I", total) + type_ + payload


def full_box(type_: bytes, version: int, flags: int, payload: bytes) -> bytes:
    """A box that starts with a version byte and three flag bytes."""
    head = struct.pack(">B", version) + struct.pack(">I", flags)[1:]
    built = box(type_, head + payload)
    expected = FIXED_SIZES.get((type_, version), "unset")
    if isinstance(expected, int) and len(built) != expected:
        raise ContainerError(
            f"{type_.decode()} version {version} must be {expected} bytes, "
            f"built {len(built)}. A wrong length here shifts every field after "
            f"it and players that read by offset show a distorted picture."
        )
    return built


IDENTITY_MATRIX = struct.pack(
    ">9I", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000
)


def run_length_encode(values: list[int]) -> list[tuple[int, int]]:
    """`[3,3,3,4]` becomes `[(3,3),(1,4)]`.

    The sample tables in `moov` are all written this way, and on a fifteen
    minute recording it is the difference between a 400 KB index and a 4 MB one.
    """
    out: list[list[int]] = []
    for value in values:
        if out and out[-1][1] == value:
            out[-1][0] += 1
        else:
            out.append([1, value])
    return [(count, value) for count, value in out]


def table(type_: bytes, entries: list[bytes], version: int = 0, flags: int = 0,
          prefix: bytes = b"") -> bytes:
    """A full box holding a counted list of fixed-size records."""
    payload = prefix + struct.pack(">I", len(entries)) + b"".join(entries)
    return full_box(type_, version, flags, payload)
