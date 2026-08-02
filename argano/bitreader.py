"""Bit-level reading for codec headers.

H.264 and H.265 write their headers as a bit stream, not as bytes, and the
numbers in them are Exp-Golomb coded. Reading a slice header means reading
single bits, so this is the floor everything else stands on.

The other job here is emulation prevention. Inside a NAL unit the encoder is
not allowed to emit the byte sequence 00 00 00, 00 00 01, 00 00 02 or 00 00 03,
because a decoder scanning for a start code would trip over it. It inserts a 03
after any 00 00 and the decoder takes it back out. Read a slice header without
undoing that and the first zero-heavy field puts you one byte out of step for
the rest of the header.
"""

from __future__ import annotations


class BitstreamError(ValueError):
    """The bits do not say what the syntax says they should."""


def remove_emulation_prevention(data: bytes, limit: int | None = None) -> bytes:
    """Take the 03 bytes back out of a NAL payload.

    `limit` stops the work early. Slice headers live in the first few dozen
    bytes and the payload can be a megabyte, so callers that only need the
    header should say so.
    """
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        if i + 2 < n and data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 3:
            out += data[i : i + 2]
            i += 3
        else:
            out.append(data[i])
            i += 1
        if limit is not None and len(out) >= limit:
            break
    return bytes(out)


class BitReader:
    """Reads bits, Exp-Golomb codes and flags out of a byte string."""

    __slots__ = ("data", "pos", "_bitlen")

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0
        self._bitlen = len(data) * 8

    @property
    def bits_left(self) -> int:
        return self._bitlen - self.pos

    def u(self, n: int) -> int:
        """Read `n` bits as an unsigned integer."""
        if self.pos + n > self._bitlen:
            raise BitstreamError("read past the end of the buffer")
        value = 0
        for _ in range(n):
            byte = self.data[self.pos >> 3]
            value = (value << 1) | ((byte >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return value

    def flag(self) -> int:
        return self.u(1)

    def ue(self) -> int:
        """Unsigned Exp-Golomb.

        Count the leading zeros, read that many bits back, and the value is
        2**zeros - 1 plus what you read. The cap on the zero count is what
        stops a run of zero bytes from being read as an enormous number: no
        field this code looks at is anywhere near 2**32.
        """
        zeros = 0
        while True:
            if self.pos >= self._bitlen:
                raise BitstreamError("ran out of bits inside an Exp-Golomb code")
            bit = self.u(1)
            if bit:
                break
            zeros += 1
            if zeros > 31:
                raise BitstreamError("Exp-Golomb prefix too long to be real")
        if zeros == 0:
            return 0
        return (1 << zeros) - 1 + self.u(zeros)

    def se(self) -> int:
        """Signed Exp-Golomb: the unsigned value folded around zero."""
        k = self.ue()
        return (k + 1) // 2 if k % 2 else -(k // 2)

    def skip_scaling_list(self, size: int) -> None:
        """Step over a scaling list without keeping it.

        Only the length matters here. Nothing downstream reads the matrices,
        and a wrong value would only ever affect a picture this code does not
        decode.
        """
        last = 8
        nxt = 8
        for _ in range(size):
            if nxt != 0:
                delta = self.se()
                nxt = (last + delta + 256) % 256
            last = nxt if nxt != 0 else last
