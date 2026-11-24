#!/usr/bin/env python3
"""5 路写端：一个进程、5 个 v2 段。默认全是合成帧；--real-camera 时第 1 路改为真实摄像头。

v2 用 overwrite：写者不等读者。某一路慢，只在自己的游标上看到 Gap。
"""

from __future__ import annotations

import argparse
import array
import atexit
import importlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time

from frames import FrameFactory


def _load_shmring():
    """优先用已安装的包；否则回退到仓库源码，保证 clone 即跑。"""
    try:
        return importlib.import_module("shmring")
    except ImportError:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = (
        os.path.join(here, "..", "..", ".."),       # examples/<demo>/python -> 库根
        os.path.join(here, "..", "..", "shmring"),  # 独立 demo/python（与库根平级）
    )
    for candidate in candidates:
        root = os.path.abspath(candidate)
        if os.path.isfile(os.path.join(root, "shmring", "_protocol.py")):
            sys.path.insert(0, root)
            return importlib.import_module("shmring")
    raise ImportError(
        "未找到 shmring：请 pip install shmring，或把本示例放在 shmring 仓库的 examples/ 下"
    )


shmring = _load_shmring()

SLOT_COUNT = 4
META_CAPACITY = 128


class Channel:
    """一路 = 一个 v2 段。overwrite：publish 不等读者。"""

    def __init__(self, cam_id: int, name: str, capacity: int, width: int, height: int,
                 mime: str, source: str):
        self.cam_id = cam_id
        self.name = name
        self.writer = shmring.ShmRingWriterV2(
            name,
            capacity=capacity,
            slot_count=SLOT_COUNT,
            meta_capacity=META_CAPACITY,
            overflow="overwrite",
            replace=True,
        )
        self.meta = json.dumps(
            {
                "cam": cam_id + 1,
                "w": width,
                "h": height,
                "mime": mime,
                "src": source,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        if len(self.meta) > self.writer.meta_capacity:
            raise ValueError("meta 超过 meta_capacity")
        self.published = 0
        self.last_publish_at = 0.0

    def publish(self, payload: bytes) -> None:
        result = self.writer.publish(payload, meta=self.meta)
        if not result.accepted:
            return
        self.published += 1
        self.last_publish_at = time.time()

    def close(self) -> None:
        self.writer.unlink()


class SyntheticSource(threading.Thread):
    """每路一个线程：按目标帧率从预生成帧表里取帧发布。"""

    def __init__(
        self,
        channel: Channel,
        factory: FrameFactory,
        fps: int,
        stop_event: threading.Event,
    ):
        super().__init__(name=f"cam-{channel.cam_id + 1}", daemon=True)
        self._channel = channel
        self._factory = factory
        self._fps = max(1, fps)
        self._stop = stop_event
        self.error: str | None = None

    def run(self) -> None:
        interval = 1.0 / self._fps
        n = 0
        try:
            while not self._stop.is_set():
                began = time.perf_counter()
                self._channel.publish(self._factory.frame(self._channel.cam_id, n))
                n += 1
                time.sleep(max(0.0, interval - (time.perf_counter() - began)))
        except Exception as exc:  # 让主线程能感知某一路挂了
            self.error = f"{type(exc).__name__}: {exc}"


def pick_dshow_mode(ffmpeg_bin: str, device: str, width: int, height: int):
    """Closest MJPEG mode the device actually exposes. 640x360 is often missing."""
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-list_options", "true", "-f", "dshow", "-i", f"video={device}"],
            capture_output=True, text=True, timeout=8, encoding="utf-8", errors="ignore",
        )
    except Exception:
        return None
    found = re.findall(
        r"vcodec=mjpeg\s+min s=(\d+)x(\d+) fps=(\d+)",
        result.stdout + result.stderr,
    )
    modes = {(int(w), int(h), int(fps)) for w, h, fps in found}
    if not modes:
        return None
    exact = [m for m in modes if m[0] == width and m[1] == height]
    if exact:
        return max(exact, key=lambda m: m[2])
    return min(modes, key=lambda m: (abs(m[0] - width) + abs(m[1] - height), m[0] * m[1]))


def detect_dshow_cameras(ffmpeg_bin: str) -> list[str]:
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True, text=True, timeout=6, encoding="utf-8", errors="ignore",
        )
    except Exception:
        return []
    return re.findall(r'"([^"]+)"\s*\(video\)', result.stdout + result.stderr)


def probe_camera() -> tuple[str, str | None] | None:
    """Return (ffmpeg, device) when a camera can be opened, else None."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    if os.name == "nt":
        names = detect_dshow_cameras(ffmpeg)
        return (ffmpeg, names[0]) if names else None
    if sys.platform == "darwin":
        return (ffmpeg, "0")
    return (ffmpeg, "/dev/video0")


class FFmpegCameraSource(threading.Thread):
    """第 1 路：ffmpeg 读摄像头，把 MJPEG 帧 publish 进自己的段。"""

    def __init__(self, channel: Channel, ffmpeg: str, device: str | None,
                 fps: int, width: int, height: int, stop_event: threading.Event,
                 capture_mode: tuple[int, int, int] | None = None):
        super().__init__(name=f"cam-{channel.cam_id + 1}-camera", daemon=True)
        self._channel = channel
        self._ffmpeg = ffmpeg
        self._device = device
        self._fps = max(1, fps)
        self._width = width
        self._height = height
        self._stop = stop_event
        self._proc: subprocess.Popen | None = None
        self._capture_mode = capture_mode
        self.error: str | None = None
        self.capture_mode = ""

    def run(self) -> None:
        if os.name == "nt":
            if self._capture_mode:
                cap_w, cap_h, cap_fps = self._capture_mode
            else:
                cap_w, cap_h, cap_fps = self._width, self._height, 30
            self.capture_mode = f"{cap_w}x{cap_h}@{cap_fps}"
            input_args = [
                "-f", "dshow", "-framerate", str(max(1, min(cap_fps, 30))),
                "-video_size", f"{cap_w}x{cap_h}",
                "-vcodec", "mjpeg", "-i", f"video={self._device}",
            ]
            filters = f"scale={self._width}:{self._height}"
        elif sys.platform == "darwin":
            input_args = ["-f", "avfoundation", "-framerate", str(self._fps), "-i", self._device or "0"]
            filters = f"fps={self._fps},scale={self._width}:{self._height}"
        else:
            input_args = ["-f", "v4l2", "-i", self._device or "/dev/video0"]
            filters = f"fps={self._fps},scale={self._width}:{self._height}"
        cmd = [
            self._ffmpeg, "-hide_banner", "-loglevel", "error",
            *input_args, "-vf", filters, "-c:v", "mjpeg", "-q:v", "5",
            "-f", "image2pipe", "-",
        ]
        try:
            self._proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
            )
            buffer = bytearray()
            while not self._stop.is_set():
                chunk = self._proc.stdout.read(16384)
                if not chunk:
                    if self._channel.published == 0:
                        self.error = "camera produced no frames"
                    break
                buffer.extend(chunk)
                while True:
                    start = buffer.find(b"\xff\xd8")
                    if start < 0:
                        if len(buffer) > 1:
                            del buffer[:-1]
                        break
                    if start > 0:
                        del buffer[:start]
                    end = buffer.find(b"\xff\xd9", 2)
                    if end < 0:
                        break
                    end += 2
                    if end > 200:
                        view = memoryview(buffer)[:end]
                        try:
                            self._channel.publish(view)
                        finally:
                            view.release()
                    del buffer[:end]
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            if self._proc is not None and self._proc.poll() is None:
                self._proc.terminate()


class SeriesSource(threading.Thread):
    """512 Hz、160 导模拟时序。一包有多少个采样点不固定。"""

    HZ = 512
    CHANNELS = 160

    def __init__(self, name: str, stop_event: threading.Event):
        super().__init__(name="series", daemon=True)
        self.writer = shmring.ShmRingWriterV2(
            name,
            capacity=1024 * 1024,
            slot_count=SLOT_COUNT,
            meta_capacity=META_CAPACITY,
            overflow="overwrite",
            replace=True,
        )
        self._stop = stop_event
        self._rng = random.Random()
        self._gain_a = [0.35 + (c % 9) * 0.07 for c in range(self.CHANNELS)]
        self._gain_b = [0.12 + (c % 5) * 0.04 for c in range(self.CHANNELS)]
        self.published = 0
        self.error: str | None = None

    def run(self) -> None:
        sample_index = 0
        next_at = time.perf_counter()
        channels = self.CHANNELS
        try:
            while not self._stop.is_set():
                count = self._rng.randint(8, 32)
                buf = array.array("f", [0.0]) * (count * channels)
                cursor = 0
                for k in range(count):
                    t = (sample_index + k) / self.HZ
                    slow = math.sin(2 * math.pi * 2 * t)
                    alpha = math.sin(2 * math.pi * 10 * t)
                    burst = math.sin(2 * math.pi * 18 * t) * (0.35 + 0.65 * math.sin(2 * math.pi * 0.3 * t))
                    for c in range(channels):
                        buf[cursor] = self._gain_a[c] * alpha + self._gain_b[c] * slow + (0.25 if c % 11 == 0 else 0.04) * burst
                        cursor += 1
                meta = json.dumps(
                    {
                        "kind": "series",
                        "hz": self.HZ,
                        "ch": channels,
                        "n": count,
                        "i0": sample_index,
                    },
                    separators=(",", ":"),
                ).encode("utf-8")
                result = self.writer.publish(buf.tobytes(), meta=meta)
                if result.accepted:
                    self.published += 1
                sample_index += count
                next_at += count / self.HZ
                delay = next_at - time.perf_counter()
                if delay > 0:
                    self._stop.wait(delay)
                else:
                    next_at = time.perf_counter()
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"

    def close(self) -> None:
        self.writer.unlink()


def make_names(args: argparse.Namespace) -> list[str]:
    if args.names:
        names = [n.strip() for n in args.names.split(",") if n.strip()]
        if not names:
            raise ValueError("--names 解析后为空")
        return names
    prefix = args.prefix or ("shmring_multi_" + os.urandom(3).hex())
    return [f"{prefix}_{i + 1}" for i in range(args.cam_count)]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="shmring 5 路合成帧写端")
    p.add_argument("--names", default=None, help="逗号分隔的段名；与 --cam-count 二选一")
    p.add_argument("--prefix", default=None, help="段名前缀，自动生成 <prefix>_1..N")
    p.add_argument("--cam-count", type=int, default=5)
    p.add_argument("--fps", type=int, default=30, help="每路目标帧率")
    p.add_argument("--buffer-kb", type=int, default=512, help="每段容量 KB（默认 512）")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    p.add_argument("--variants", type=int, default=8, help="每路预生成帧数")
    p.add_argument("--stats-interval", type=float, default=2.0)
    p.add_argument("--real-camera", action="store_true",
                   help="第 1 路改用真实摄像头；没有设备时该路仍用合成帧")
    p.add_argument("--series-name", default=None, help="1000 Hz 时序段名；不传则不启动")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    names = make_names(args)
    cam_count = len(names)

    camera = probe_camera() if args.real_camera else None
    real_on = camera is not None
    mode = None
    if args.real_camera and not real_on:
        print("[python] real-camera=no reason=no-ffmpeg-or-device", flush=True)
    elif real_on:
        mode = pick_dshow_mode(camera[0], camera[1] or "", args.width, args.height) if os.name == "nt" else None
        mode_text = f"{mode[0]}x{mode[1]}@{mode[2]}" if mode else "default"
        print(f"[python] real-camera=yes device={camera[1]} mode={mode_text}", flush=True)

    factory = FrameFactory(cam_count, args.width, args.height, args.variants)
    from shmring import _protocol_v2 as v2p
    minimum = (
        v2p.HEADER_SIZE
        + SLOT_COUNT * (v2p.SLOT_HEADER_SIZE + META_CAPACITY + factory.max_frame_bytes + 4096)
    )
    if real_on:
        minimum = max(minimum, 2 * 1024 * 1024)
    capacity = max(args.buffer_kb * 1024, minimum)

    def make_channel(i: int, source: str, mime: str) -> Channel:
        return Channel(i, names[i], capacity, args.width, args.height, mime, source)

    channels = []
    for i in range(cam_count):
        if real_on and i == 0:
            channels.append(make_channel(i, "camera", "image/jpeg"))
        else:
            channels.append(make_channel(i, "synthetic", "image/png"))
    if factory.max_frame_bytes > channels[-1].writer.payload_capacity:
        raise SystemExit(
            f"容量计算异常：单帧 {factory.max_frame_bytes} B > "
            f"槽容量 {channels[-1].writer.payload_capacity} B"
        )

    stop_event = threading.Event()
    sources = []
    for ch in channels:
        if real_on and ch.cam_id == 0:
            sources.append(FFmpegCameraSource(
                ch, camera[0], camera[1], args.fps, args.width, args.height, stop_event, mode,
            ))
        else:
            sources.append(SyntheticSource(ch, factory, args.fps, stop_event))

    series = SeriesSource(args.series_name, stop_event) if args.series_name else None
    cleaned = False

    def cleanup() -> None:
        nonlocal cleaned
        if cleaned:
            return
        cleaned = True
        stop_event.set()
        for src in sources:
            if src.is_alive():
                src.join(timeout=0.5)
        if series is not None and series.is_alive():
            series.join(timeout=0.5)
        for ch in channels:
            try:
                ch.close()
            except Exception:
                pass
        if series is not None:
            try:
                series.close()
            except Exception:
                pass

    atexit.register(cleanup)

    for src in sources:
        src.start()
    if series is not None:
        series.start()

    print(
        f"[python] ready cam_count={cam_count} fps={args.fps} "
        f"names={','.join(names)} png={factory.min_frame_bytes}~{factory.max_frame_bytes}B "
        f"buffer={capacity}B/cam slots={SLOT_COUNT} "
        f"protocol=v{channels[0].writer.info.protocol_version} "
        f"real-camera={'yes' if real_on else 'no'} "
        f"series={'yes' if series is not None else 'no'}",
        flush=True,
    )

    last_log = time.monotonic()
    last_counts = [0] * cam_count
    try:
        while not stop_event.wait(0.25):
            errors = [s.error for s in sources if s.error]
            if series is not None and series.error:
                print(f"[python] series error: {series.error}", flush=True, file=sys.stderr)
                series.error = None
            if errors:
                cam_err = sources[0].error if real_on and isinstance(sources[0], FFmpegCameraSource) else None
                if cam_err and sources[0].error == errors[0]:
                    print(f"[python] real-camera fallback: {cam_err}", flush=True)
                    channels[0].meta = json.dumps(
                        {"cam": 1, "w": args.width, "h": args.height, "mime": "image/png", "src": "synthetic"},
                        separators=(",", ":"),
                    ).encode("utf-8")
                    sources[0] = SyntheticSource(channels[0], factory, args.fps, stop_event)
                    sources[0].start()
                    real_on = False
                    continue
                print(f"[python] source error: {errors[0]}", flush=True, file=sys.stderr)
                break
            now = time.monotonic()
            if now - last_log >= args.stats_interval:
                counts = [ch.published for ch in channels]
                per_cam = [
                    round((counts[i] - last_counts[i]) / (now - last_log), 1)
                    for i in range(cam_count)
                ]
                print(
                    "[python] fps/cam="
                    + ",".join(f"{v:.1f}" for v in per_cam)
                    + f" total={sum(per_cam):.1f}",
                    flush=True,
                )
                last_log, last_counts = now, counts
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
