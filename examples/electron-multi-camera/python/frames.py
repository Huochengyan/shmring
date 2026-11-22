#!/usr/bin/env python3
"""合成帧工厂：纯标准库生成有效 PNG，启动时预生成、运行时循环复用。

预生成是关键：PNG 的 zlib 压缩若放在每帧里做，会成为 benchmark 的主要噪声，
也掩盖了「shmring.publish() 只是一次 memcpy」这一事实。这里每路预生成若干
变体帧（移动色条 + 路专属色相），运行期只做查表，载荷大小固定可比。
"""

from __future__ import annotations

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def make_png(
    width: int,
    height: int,
    hue: int,
    bar_x: int,
    bar_rgb: tuple[int, int, int] = (255, 64, 128),
    bar_width: int = 80,
    compress_level: int = 6,
) -> bytes:
    """生成一张 640x360 风格的 RGB PNG：横向/纵向渐变 + 路专属色相 + 移动色条。"""
    ramp = bytes((x * 255) // width for x in range(width))
    rows = []
    for y in range(height):
        row = bytearray(width * 3)
        row[0::3] = ramp
        row[1::3] = bytes([(y * 255) // height]) * width
        row[2::3] = bytes([hue]) * width
        rows.append(b"\x00" + bytes(row))
    raw = bytearray(b"".join(rows))

    stride = width * 3 + 1
    bar = bytes(bar_rgb) * bar_width
    for y in range(height // 3, 2 * height // 3):
        start = y * stride + 1 + bar_x * 3
        raw[start : start + bar_width * 3] = bar

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), compress_level))
        + _chunk(b"IEND", b"")
    )


class FrameFactory:
    """cam_count 路 × variants 张预生成帧；frame(cam, n) 为 O(1) 查表。"""

    HUES = (40, 95, 150, 205, 250, 65, 120, 180)

    def __init__(
        self,
        cam_count: int = 5,
        width: int = 640,
        height: int = 360,
        variants: int = 8,
        compress_level: int = 6,
    ):
        self.width = width
        self.height = height
        self.variants = variants
        self.cam_count = cam_count
        self.compress_level = compress_level
        bar_width = max(8, width // 8)
        self._frames: list[list[bytes]] = []
        for cam in range(cam_count):
            hue = self.HUES[cam % len(self.HUES)]
            seq = []
            for v in range(variants):
                bar_x = int((v / variants) * max(1, width - bar_width))
                seq.append(
                    make_png(
                        width,
                        height,
                        hue,
                        bar_x,
                        bar_width=bar_width,
                        compress_level=compress_level,
                    )
                )
            self._frames.append(seq)
        self.max_frame_bytes = max(len(f) for seq in self._frames for f in seq)
        self.min_frame_bytes = min(len(f) for seq in self._frames for f in seq)

    def frame(self, cam: int, frame_no: int) -> bytes:
        seq = self._frames[cam]
        return seq[frame_no % len(seq)]

    def summary(self) -> dict:
        return {
            "cam_count": self.cam_count,
            "width": self.width,
            "height": self.height,
            "variants": self.variants,
            "png_min_bytes": self.min_frame_bytes,
            "png_max_bytes": self.max_frame_bytes,
        }
