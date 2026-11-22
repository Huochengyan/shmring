#!/usr/bin/env python3
"""5 路合成帧写端：一个进程、5 个命名段、5 个 ShmRingWriter 实例并发发布。

与单路 showcase 的区别（也是这个示例要证明的事）：
1. 库没有进程级可变全局状态，同一进程内 N 个 writer 实例各写各的段，
   帧号 / seq / 槽几何 / 锁全部实例隔离，互不干扰；
2. 业务语义（cam_id / w / h / mime）放进每帧 meta，库只看到不透明字节；
3. 帧在启动时预生成，运行期只做 publish()，不掺入 PNG 编码开销。

数据链路（零 HTTP）：
  FrameFactory -> Channel(k).writer.publish() -> OS 命名段 shm_*_k
    -> Electron 主进程 5 个 ShmRingReader.readBatch() -> 一次批量 IPC
"""

from __future__ import annotations

import argparse
import atexit
import importlib
import json
import os
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
    """一路 = 一个段 + 一个 writer 实例 + 一份固定 meta。"""

    def __init__(self, cam_id: int, name: str, capacity: int, width: int, height: int):
        self.cam_id = cam_id
        self.name = name
        self.writer = shmring.ShmRingWriter(
            name,
            capacity=capacity,
            slot_count=SLOT_COUNT,
            meta_capacity=META_CAPACITY,
            replace=True,
        )
        self.meta = json.dumps(
            {"cam": cam_id + 1, "w": width, "h": height, "mime": "image/png"},
            separators=(",", ":"),
        ).encode("utf-8")
        if len(self.meta) > self.writer.meta_capacity:
            raise ValueError("meta 超过 meta_capacity")
        self.published = 0
        self.last_publish_at = 0.0

    def publish(self, payload: bytes) -> None:
        self.writer.publish(payload, meta=self.meta)
        self.published += 1
        self.last_publish_at = time.time()

    def close(self) -> None:
        # unlink() 内部会 close；POSIX 删除 OS 对象，Windows 由内核引用计数回收。
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
    return p.parse_args()


def main() -> int:
    args = parse_args()
    names = make_names(args)
    cam_count = len(names)

    factory = FrameFactory(cam_count, args.width, args.height, args.variants)
    # 按实际最大帧尺寸自动兜底：单槽 payload 容量必须 >= 最大帧 + 4KB 余量。
    # 用户调大 --width/--height 时不用手动换算 --buffer-kb。
    minimum = 64 + SLOT_COUNT * (32 + META_CAPACITY + factory.max_frame_bytes + 4096)
    capacity = max(args.buffer_kb * 1024, minimum)
    payload_capacity = (capacity - 64) // SLOT_COUNT - (32 + META_CAPACITY)
    if factory.max_frame_bytes > payload_capacity:
        raise SystemExit(
            f"容量计算异常：单帧 {factory.max_frame_bytes} B > 槽容量 {payload_capacity} B"
        )

    channels = [Channel(i, names[i], capacity, args.width, args.height) for i in range(cam_count)]
    stop_event = threading.Event()
    sources = [
        SyntheticSource(ch, factory, args.fps, stop_event) for ch in channels
    ]

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
        for ch in channels:
            try:
                ch.close()
            except Exception:
                pass

    atexit.register(cleanup)

    for src in sources:
        src.start()

    print(
        f"[python] ready cam_count={cam_count} fps={args.fps} "
        f"names={','.join(names)} png={factory.min_frame_bytes}~{factory.max_frame_bytes}B "
        f"buffer={capacity}B/cam slots={SLOT_COUNT} protocol=v{shmring.PROTOCOL_VERSION}",
        flush=True,
    )

    last_log = time.monotonic()
    last_counts = [0] * cam_count
    try:
        while not stop_event.wait(0.25):
            errors = [s.error for s in sources if s.error]
            if errors:
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
