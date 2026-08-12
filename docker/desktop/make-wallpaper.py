#!/usr/bin/env python3
"""Generate the desktop wallpaper at build time.

A downloaded photo would add megabytes to a shared image and pull a network
dependency into the build; a flat colour looks unfinished. So we synthesise a
soft vertical gradient with a subtle vignette — a few KB, no dependencies
beyond Python's zlib, and it scales to any resolution we pick later.
"""
import struct
import sys
import zlib

W, H = 1440, 900
TOP = (36, 46, 82)      # deep indigo
BOTTOM = (110, 76, 132)  # muted violet
OUT = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/backgrounds/omb.png"


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


rows = []
for y in range(H):
    t = y / (H - 1)
    # Ease the gradient so the middle band is wider and the ends are softer.
    e = t * t * (3 - 2 * t)
    r, g, b = (lerp(TOP[i], BOTTOM[i], e) for i in range(3))
    row = bytearray([0])  # PNG filter type 0 for this scanline
    for x in range(W):
        # Gentle horizontal vignette: darker at the edges, neutral center.
        dx = abs(x - W / 2) / (W / 2)
        v = 1.0 - 0.18 * dx * dx
        row += bytes((int(r * v), int(g * v), int(b * v)))
    rows.append(bytes(row))

raw = zlib.compress(b"".join(rows), 9)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", raw)
    + chunk(b"IEND", b"")
)

with open(OUT, "wb") as fh:
    fh.write(png)
print(f"wallpaper: {OUT} ({len(png)} bytes, {W}x{H})")
