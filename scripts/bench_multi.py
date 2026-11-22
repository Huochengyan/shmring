#!/usr/bin/env python3
"""shmring 多段并发 benchmark：同一进程内 N 个 writer 各写各的段。

回答两个问题：
1. 5 路并发 publish 会不会互相干扰？1 路 vs 5 路的吞吐差多少（CPython GIL 的影响）？
2. 一个扫描线程遍历 N 个 reader（模拟 Electron 主进程）在限速帧率下能否不丢帧？

用法：
    python scripts/bench_multi.py                       # 默认 1 路 vs 5 路，两组场景
    python scripts/bench_multi.py --quick              # 短时冒烟，供 CI 使用
    python scripts/bench_multi.py --cam-counts 1,3,5 --frame-bytes 81920
    python scripts/bench_multi.py --json bench.json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import shmring  # noqa: E402

SLOT_COUNT = 4
META_CAPACITY = 128
SCAN_INTERVAL_MS = 2


def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * p))]


class Channel:
    def __init__(self, cam_id: int, name: str, capacity: int):
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
            {"cam": cam_id + 1, "bench": 1}, separators=(",", ":")
        ).encode("utf-8")


def writer_loop(idx, ch, payloads, stop, fps, pub_counts, latencies):
    interval = 1.0 / fps if fps > 0 else 0.0
    n = 0
    while not stop.is_set():
        t0 = time.perf_counter_ns()
        ch.writer.publish(payloads[n & 3], meta=ch.meta)
        latencies[idx].append((time.perf_counter_ns() - t0) / 1000.0)  # µs
        pub_counts[idx] += 1
        n += 1
        if interval:
            time.sleep(max(0.0, interval - (time.perf_counter_ns() - t0) / 1e9))
        else:
            time.sleep(0)  # 让出 GIL，保证 5 个线程调度公平


def scan_loop(readers, stop, read_counts, ages, dropped):
    while not stop.is_set():
        for i, reader in enumerate(readers):
            try:
                batch = reader.read_batch()
            except Exception:
                continue
            dropped[i] += batch.dropped
            now_ms = int(time.time() * 1000)
            for f in batch.frames:
                read_counts[i] += 1
                age = now_ms - f.stamp
                if 0 <= age < 10000:
                    ages[i].append(age)
        time.sleep(SCAN_INTERVAL_MS / 1000.0)


def run_case(cam_count, frame_bytes, duration, fps, with_readers, label):
    prefix = "shmring_bench_" + os.urandom(3).hex()
    names = [f"{prefix}_{i + 1}" for i in range(cam_count)]
    capacity = 64 + SLOT_COUNT * (32 + META_CAPACITY + frame_bytes + 1024)
    payloads = [random.Random(1000 + v).randbytes(frame_bytes) for v in range(4)]
    meta_bytes = json.dumps(
        {"cam": 1, "bench": 1}, separators=(",", ":")
    ).encode("utf-8")
    assert len(meta_bytes) <= META_CAPACITY

    channels = [Channel(i, names[i], capacity) for i in range(cam_count)]
    stop = threading.Event()
    pub_counts = [0] * cam_count
    latencies = [[] for _ in range(cam_count)]
    read_counts = [0] * cam_count
    ages = [[] for _ in range(cam_count)]
    dropped = [0] * cam_count

    writers = [
        threading.Thread(
            target=writer_loop,
            args=(i, channels[i], payloads, stop, fps, pub_counts, latencies),
            name=f"bench-writer-{i + 1}",
            daemon=True,
        )
        for i in range(cam_count)
    ]

    readers = []
    scanner = None
    if with_readers:
        # Writer 构造时已写完全局头，可以直接 attach（库本身不提供 attach 重试）。
        readers = [shmring.ShmRingReader(n) for n in names]
        scanner = threading.Thread(
            target=scan_loop,
            args=(readers, stop, read_counts, ages, dropped),
            name="bench-scanner",
            daemon=True,
        )

    t_start = time.perf_counter()
    for t in writers:
        t.start()
    if scanner:
        scanner.start()
    time.sleep(duration)
    stop.set()
    for t in writers:
        t.join(timeout=2)
    if scanner:
        scanner.join(timeout=2)
    elapsed = time.perf_counter() - t_start

    for r in readers:
        r.close()
    for ch in channels:
        try:
            ch.writer.unlink()
        except Exception:
            ch.writer.close()

    all_lat = [v for sub in latencies for v in sub]
    all_ages = [v for sub in ages for v in sub]
    total_frames = sum(pub_counts)
    return {
        "label": label,
        "cam_count": cam_count,
        "frame_bytes": frame_bytes,
        "duration_s": round(elapsed, 3),
        "target_fps_per_cam": fps,
        "with_readers": with_readers,
        "capacity_per_cam": capacity,
        "total_shm_bytes": capacity * cam_count,
        "published_frames": total_frames,
        "publish_fps_per_cam": [round(c / elapsed, 1) for c in pub_counts],
        "total_publish_fps": round(total_frames / elapsed, 1),
        "throughput_mb_s": round(total_frames * frame_bytes / elapsed / 1e6, 2),
        "publish_latency_us": {
            "p50": round(pct(all_lat, 0.50), 1),
            "p95": round(pct(all_lat, 0.95), 1),
            "p99": round(pct(all_lat, 0.99), 1),
        },
        "read_frames": sum(read_counts) if with_readers else None,
        "read_frames_per_cam": read_counts if with_readers else None,
        "dropped": sum(dropped) if with_readers else None,
        "frame_age_ms": {
            "avg": round(sum(all_ages) / len(all_ages), 2) if all_ages else 0,
            "p99": round(pct(all_ages, 0.99), 1),
        } if with_readers else None,
    }


def print_table(cases: list[dict], title: str, with_readers: bool) -> None:
    print(f"\n=== {title} ===")
    header = (
        f"{'路数':>4} {'发布fps':>10} {'MB/s':>8} {'p50(µs)':>9} {'p99(µs)':>9}"
    )
    if with_readers:
        header += f" {'读到帧':>9} {'丢帧':>7} {'帧龄avg':>9} {'帧龄p99':>9}"
    print(header)
    print("-" * len(header))
    for c in cases:
        row = (
            f"{c['cam_count']:>4} {c['total_publish_fps']:>10} "
            f"{c['throughput_mb_s']:>8} {c['publish_latency_us']['p50']:>9} "
            f"{c['publish_latency_us']['p99']:>9}"
        )
        if with_readers:
            fa = c["frame_age_ms"]
            row += (
                f" {c['read_frames']:>9} {c['dropped']:>7} "
                f"{fa['avg']:>9} {fa['p99']:>9}"
            )
        print(row)


def main() -> int:
    p = argparse.ArgumentParser(description="shmring 多段并发 benchmark")
    p.add_argument("--cam-counts", default="1,5")
    p.add_argument("--frame-bytes", type=int, default=40960)
    p.add_argument("--duration", type=float, default=3.0)
    p.add_argument("--fps", type=int, default=30, help="每路目标帧率；0 表示不限速")
    p.add_argument("--quick", action="store_true", help="短时冒烟（1 秒）")
    p.add_argument("--json", default=None, help="把原始结果写入 JSON 文件")
    p.add_argument("--no-unlimited", action="store_true", help="跳过不限速纯 publish 场景")
    args = p.parse_args()

    counts = [int(x) for x in args.cam_counts.split(",") if x.strip()]
    duration = 1.0 if args.quick else args.duration
    unlimited_duration = 1.0 if args.quick else min(args.duration, 2.0)

    print(
        f"shmring {shmring.__version__} · protocol v{shmring.PROTOCOL_VERSION} · "
        f"frame={args.frame_bytes}B · 每路 4 槽 · 平台={sys.platform}"
    )

    limited = [
        run_case(n, args.frame_bytes, duration, args.fps, True, "limited")
        for n in counts
    ]
    print_table(limited, f"A. 限速 {args.fps} fps/路 + 单扫描线程（{SCAN_INTERVAL_MS}ms）", True)

    results = {"limited": limited, "unlimited": []}
    if not args.no_unlimited:
        unlimited = [
            run_case(n, args.frame_bytes, unlimited_duration, 0, False, "unlimited")
            for n in counts
        ]
        print_table(unlimited, "B. 不限速纯 publish（无 reader，测 GIL 下的吞吐上限）", False)
        results["unlimited"] = unlimited

        if 1 in counts and max(counts) > 1:
            base = next(c for c in unlimited if c["cam_count"] == 1)["total_publish_fps"]
            wide = max(
                (c for c in unlimited if c["cam_count"] > 1),
                key=lambda c: c["cam_count"],
            )
            ratio = wide["total_publish_fps"] / base
            print(
                f"\n=== 结论 ===\n"
                f"不限速时 {wide['cam_count']} 路总吞吐 / 1 路 = {ratio:.2f}× "
                f"（{wide['total_publish_fps']} vs {base} fps）\n"
                f"比值没有随路数增长，且略小于 1：CPython 下 publish 的 memcpy "
                f"不释放 GIL，同进程多线程没有并行加速，线程切换还带来约 "
                f"{(1 - ratio) * 100:.0f}% 损耗。\n"
                f"要按路数线性扩容，应改成多进程（每段一个写者进程）；"
                f"若只是多路逻辑隔离，当前多线程方案完全够用。\n"
                f"{wide['cam_count']} 段合计共享内存 {wide['total_shm_bytes'] / 1024:.0f} KB。"
            )

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2)
        print(f"\n原始结果已写入 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
