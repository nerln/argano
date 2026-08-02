#!/usr/bin/env python3
"""Break a working video on purpose, so a repair can be measured against it.

Testing a recovery tool needs files that are damaged in known ways and whose
correct answer is known too. Collecting real broken files gives you neither:
you cannot tell whether the frame it did not find was ever there.

So the fixtures are made here. Take a file that works, record what is in it,
apply one of the accidents that actually happen to people, and keep the
original to compare against.

    python tools/damage.py unfinalised in.mp4 out.mov
    python tools/damage.py garbage in.mp4 out.mov --runs 3 --bytes 40000
    python tools/damage.py truncate in.mp4 out.mov --keep 0.6
    python tools/damage.py header in.mp4 out.mov

The accidents:

unfinalised  the index is never written and the media length is left at zero,
             which is what a recorder that was killed or ran out of battery
             leaves behind. By far the most common one.
garbage      the index is gone and runs of random bytes are written over the
             media, which is what a failing card or a filesystem that lost a
             write produces.
truncate     the file simply stops, as an interrupted copy or download does.
header       the index is present but its first bytes are overwritten, so the
             file looks structured and reads as nothing.
"""

from __future__ import annotations

import argparse
import random
import struct
import sys
from pathlib import Path


def top_level_boxes(data: bytes) -> list[tuple[bytes, int, int]]:
    boxes = []
    offset = 0
    while offset + 8 <= len(data):
        size = struct.unpack(">I", data[offset : offset + 4])[0]
        type_ = data[offset + 4 : offset + 8]
        header = 8
        if size == 1:
            size = struct.unpack(">Q", data[offset + 8 : offset + 16])[0]
            header = 16
        elif size == 0:
            size = len(data) - offset
        if size < header:
            break
        boxes.append((type_, offset, size))
        offset += size
    return boxes


def find(boxes, want: bytes):
    for type_, offset, size in boxes:
        if type_ == want:
            return offset, size
    return None


def strip_index(data: bytes, blank_length: bool = True) -> bytes:
    """Remove `moov` and optionally leave the media length unwritten."""
    boxes = top_level_boxes(data)
    moov = find(boxes, b"moov")
    mdat = find(boxes, b"mdat")
    if mdat is None:
        raise SystemExit("this file has no mdat, so there is nothing to damage")

    keep = bytearray()
    for type_, offset, size in boxes:
        if type_ == b"moov":
            continue
        keep += data[offset : offset + size]

    out = bytearray(keep)
    if blank_length:
        # Find the media box again in the trimmed output and blank its length,
        # exactly as a recorder does when it never comes back to fill it in.
        for type_, offset, size in top_level_boxes(bytes(out)):
            if type_ == b"mdat":
                out[offset : offset + 4] = (0).to_bytes(4, "big")
                break
    return bytes(out)


def inject_garbage(data: bytes, runs: int, length: int, seed: int) -> bytes:
    """Overwrite runs of media with random bytes."""
    rng = random.Random(seed)
    out = bytearray(data)
    boxes = top_level_boxes(bytes(out))
    mdat = find(boxes, b"mdat")
    if mdat is None:
        raise SystemExit("no mdat to damage")
    start = mdat[0] + 8
    end = mdat[0] + mdat[1]
    span = end - start
    if span <= length * runs * 2:
        raise SystemExit("the media is too short for that much damage")

    positions = sorted(rng.sample(range(start + span // 10, end - length), runs))
    for position in positions:
        out[position : position + length] = bytes(
            rng.getrandbits(8) for _ in range(length)
        )
    print(f"  wrote {runs} runs of {length} random bytes at "
          + ", ".join(f"{p:,}" for p in positions))
    return bytes(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("mode", choices=["unfinalised", "garbage", "truncate", "header"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--bytes", type=int, default=40000, dest="length")
    parser.add_argument("--keep", type=float, default=0.6,
                        help="fraction of the file to keep when truncating")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args(argv)

    data = args.source.read_bytes()
    print(f"{args.source.name}: {len(data):,} bytes")

    if args.mode == "unfinalised":
        out = strip_index(data)
    elif args.mode == "garbage":
        out = inject_garbage(strip_index(data), args.runs, args.length, args.seed)
    elif args.mode == "truncate":
        out = strip_index(data)[: int(len(data) * args.keep)]
    else:
        stripped = bytearray(data)
        boxes = top_level_boxes(data)
        moov = find(boxes, b"moov")
        if moov is None:
            raise SystemExit("no moov to corrupt")
        offset = moov[0] + 8
        stripped[offset : offset + 512] = b"\x00" * 512
        out = bytes(stripped)

    args.destination.write_bytes(out)
    print(f"wrote {args.destination} ({len(out):,} bytes, {args.mode})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
