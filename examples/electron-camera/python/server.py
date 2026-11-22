#!/usr/bin/env python3
"""Python 服务端：采集画面 -> 用 shmring 写入共享内存 -> 交由 Electron 直接读取。

设计要点：
1. 所有图像数据只存在于内存（OS 共享内存段 + 进程内存），不落磁盘；
2. 共享内存协议完全由 shmring 库负责（4 槽环形缓冲 + 显式 seqlock + magic/version 校验），
   本文件只把 width / height / mime 编码进每帧 meta；
3. 优先用 ffmpeg 读取摄像头；其次 OpenCV；都没有时用纯标准库生成测试画面；
4. HTTP 接口仅用于调试（--no-http 时关闭），主链路是共享内存直连。
"""

from __future__ import annotations

import argparse
import atexit
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import zlib
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---- shmring 依赖解析 ----------------------------------------------------
# 本 demo 是 shmring 的 showcase：内存布局、seqlock、环形覆盖、平台段名差异
# 全部交给库，这里只把「图像帧语义」编码进每帧的 meta（紧凑 JSON）。
# 优先用已安装的包；找不到时回退到仓库源码，保证 clone 即跑、独立 demo 目录也能跑。
def _load_shmring():
    import importlib

    try:
        return importlib.import_module("shmring")
    except ImportError:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = (
        os.path.join(here, "..", "..", ".."),       # examples/electron-camera/python -> 库根
        os.path.join(here, "..", "..", "shmring"),  # 平级独立 demo/python -> 库根
    )
    for candidate in candidates:
        root = os.path.abspath(candidate)
        if os.path.isfile(os.path.join(root, "shmring", "_protocol.py")):
            sys.path.insert(0, root)
            return importlib.import_module("shmring")
    raise ImportError(
        "未找到 shmring：请 pip install shmring，或把本 demo 放在 shmring 仓库的 "
        "examples/ 下，或让 shmring 仓库与本目录平级"
    )


shmring = _load_shmring()

# 载荷在库里是不透明字节；width / height / mime 放进每帧 meta。
META_CAPACITY = 256
SLOT_COUNT = 4
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class FrameBus:
    """shmring 的图像语义适配层。

    库只认不透明字节帧，本类负责三件事：
    - 把 width / height / mime 编码成每帧的 meta（紧凑 JSON）；
    - 维护 demo 需要的 fps / 帧号 / 尺寸等统计；
    - 提供 read() 供 HTTP 调试接口取最新帧。

    4 槽环形缓冲、seqlock 奇偶校验、批量读取、跨平台段名差异全部由 shmring 实现，
    本文件不再出现任何 struct 布局或 FFI 代码。
    """

    def __init__(self, name: str | None, buffer_bytes: int):
        segment_name = name or "shmring_demo_" + os.urandom(4).hex()
        self._writer = shmring.ShmRingWriter(
            segment_name,
            capacity=buffer_bytes,
            slot_count=SLOT_COUNT,
            meta_capacity=META_CAPACITY,
            replace=True,
        )
        self._reader = shmring.ShmRingReader(self._writer.info.name)
        self.name = self._writer.info.name
        info = self._writer.info
        self.slot_count = info.slot_count
        self.slot_size = info.slot_size
        self.slot_capacity = info.payload_capacity

        self._lock = threading.Lock()
        self._started = time.time()
        self._fps_window: deque[float] = deque(maxlen=40)
        self._last_publish_at = 0.0
        self._frame_id = -1
        self._stamp = 0
        self._width = 0
        self._height = 0
        self._mime = "image/png"
        self._meta_cache: dict[tuple[int, int, str], bytes] = {}

    def _meta(self, width: int, height: int, mime: str) -> bytes:
        key = (width, height, mime)
        cached = self._meta_cache.get(key)
        if cached is None:
            cached = json.dumps(
                {"w": width, "h": height, "mime": mime},
                separators=(",", ":"),
            ).encode("utf-8")
            if len(cached) > self._writer.meta_capacity:
                raise ValueError("meta 超过库配置的 meta_capacity")
            self._meta_cache[key] = cached
        return cached

    def publish(self, data: bytes | bytearray | memoryview, width: int, height: int, mime: str) -> None:
        # data 满足 buffer protocol 即可：ffmpeg 路径传的是 bytearray 的 memoryview，
        # 库在 publish 内同步拷走，返回后调用方即可 release() 并 resize 原 bytearray。
        meta = self._meta(width, height, mime)
        now = time.perf_counter()
        with self._lock:
            self._writer.publish(data, meta=meta)
            self._frame_id += 1
            self._stamp = int(time.time() * 1000)
            self._width, self._height, self._mime = width, height, mime
            if self._last_publish_at:
                self._fps_window.append(now - self._last_publish_at)
            self._last_publish_at = now

    def read(self) -> dict | None:
        """读最新完整帧，供 HTTP /frame、/stream 使用。"""
        frame = self._reader.read()
        if frame is None:
            return None
        meta = self._decode_meta(frame.meta)
        return {
            "data": frame.payload,
            "width": meta.get("w", 0),
            "height": meta.get("h", 0),
            "stamp": frame.stamp,
            "id": frame.frame_id,
            "mime": meta.get("mime", "image/jpeg"),
        }

    @staticmethod
    def _decode_meta(raw: bytes) -> dict:
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return {}

    def stats(self) -> dict:
        with self._lock:
            intervals = list(self._fps_window)
            fps = round(1.0 / (sum(intervals) / len(intervals)), 1) if intervals else 0.0
            return {
                "shared_memory_name": self.name,
                "buffer_bytes": self._writer.info.capacity,
                "frame_id": self._frame_id,
                "fps": fps,
                "width": self._width,
                "height": self._height,
                "mime": self._mime,
                "timestamp_ms": self._stamp,
                "uptime_seconds": round(time.time() - self._started, 1),
                "slot_count": self.slot_count,
                "slot_size": self.slot_size,
                "protocol_version": self._writer.info.protocol_version,
            }

    def close(self) -> None:
        self._reader.close()
        # writer.unlink() 内部会 close；POSIX 上同时删除 OS 对象，Windows 上由内核
        # 引用计数回收。务必不要先 close() 再 unlink()，否则 POSIX 段会残留。
        self._writer.unlink()


class CameraSource(threading.Thread):
    """OpenCV 摄像头采集线程。"""

    def __init__(self, bus: FrameBus, index: int, fps: int, width: int, height: int):
        super().__init__(name="camera-source", daemon=True)
        self._bus = bus
        self._index = index
        self._fps = fps
        self._width = width
        self._height = height
        self._stop_event = threading.Event()
        self.kind = "opencv-camera"

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        import cv2  # 只在真正使用时导入，缺失时由 main 回退到合成画面

        cap = cv2.VideoCapture(self._index)
        if os.name == "nt":
            # Windows 上 DSHOW 通常启动更快
            cap.release()
            cap = cv2.VideoCapture(self._index, cv2.CAP_DSHOW)
        if self._width:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        if self._height:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f"无法打开摄像头 index={self._index}")

        interval = 1.0 / max(1, self._fps)
        try:
            while not self._stop_event.is_set():
                began = time.perf_counter()
                ok, frame = cap.read()
                if not ok:
                    time.sleep(0.05)
                    continue
                ok, encoded = cv2.imencode(
                    ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82]
                )
                if ok:
                    self._bus.publish(
                        encoded.tobytes(), frame.shape[1], frame.shape[0], "image/jpeg"
                    )
                time.sleep(max(0.0, interval - (time.perf_counter() - began)))
        finally:
            cap.release()


def detect_dshow_cameras(ffmpeg_bin: str) -> list[str]:
    """Windows 下用 ffmpeg -list_devices 找出视频设备名称。"""
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True,
            text=True,
            timeout=6,
            encoding="utf-8",
            errors="ignore",
        )
    except Exception:
        return []
    return re.findall(r'"([^"]+)"\s*\(video\)', result.stdout + result.stderr)


class FFmpegCameraSource(threading.Thread):
    """用 ffmpeg 读摄像头，从 stdout 解析 MJPEG 帧后写入共享内存。"""

    def __init__(
        self,
        bus: FrameBus,
        ffmpeg_bin: str,
        camera_name: str | None,
        fps: int,
        width: int,
        height: int,
    ):
        super().__init__(name="ffmpeg-camera-source", daemon=True)
        self._bus = bus
        self._ffmpeg = ffmpeg_bin
        self._camera_name = camera_name
        self._fps = max(1, fps)
        self._width = width or 640
        self._height = height or 360
        self._stop_event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self.kind = "ffmpeg-camera"

    def stop(self) -> None:
        self._stop_event.set()
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()

    def run(self) -> None:
        if os.name == "nt":
            name = self._camera_name or (detect_dshow_cameras(self._ffmpeg) or [None])[0]
            if not name:
                raise RuntimeError("ffmpeg 没找到摄像头，请用 --camera-name 指定设备名")
            # 低延迟要点：请求摄像头原生模式（本机 Integrated Camera 为 MJPEG 640x360，标称 30fps
            # 实际约 27fps），不用 fps 滤镜压帧（它整帧缓冲会多一个帧周期延迟）。
            # 实测 -fflags nobuffer -flags low_delay 会让输出变成突发节奏，反而更糟，故不加。
            input_args = [
                "-f", "dshow",
                "-framerate", "30",
                "-video_size", f"{self._width}x{self._height}",
                "-vcodec", "mjpeg",
                "-i", f"video={name}",
            ]
            video_filters = f"scale={self._width}:{self._height}"
        elif sys.platform == "darwin":
            input_args = ["-f", "avfoundation", "-framerate", str(self._fps), "-i", self._camera_name or "0"]
            video_filters = f"fps={self._fps},scale={self._width}:{self._height}"
        else:
            input_args = ["-f", "v4l2", "-i", self._camera_name or "/dev/video0"]
            video_filters = f"fps={self._fps},scale={self._width}:{self._height}"

        cmd = [
            self._ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            *input_args,
            "-vf",
            video_filters,
            "-c:v",
            "mjpeg",
            "-q:v",
            "5",
            "-f",
            "image2pipe",
            "-",
        ]
        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0
        )
        buffer = bytearray()
        try:
            while not self._stop_event.is_set():
                chunk = self._proc.stdout.read(16384)
                if not chunk:
                    break
                buffer.extend(chunk)
                while True:
                    start = buffer.find(b"\xff\xd8")  # JPEG SOI
                    if start < 0:
                        # 保留最后一个字节，避免 SOI 跨 chunk 被拆开
                        if len(buffer) > 1:
                            del buffer[:-1]
                        break
                    if start > 0:
                        del buffer[:start]
                    end = buffer.find(b"\xff\xd9", 2)  # JPEG EOI
                    if end < 0:
                        break
                    end += 2
                    # memoryview 直接引用 bytearray 里的帧区间，publish 会把它写入共享内存，
                    # 省掉 buffer[:end] 切片副本和 bytes(...) 的第二次拷贝。
                    # bytearray 在 memoryview 导出期间不能 resize，故必须在 del 前 release()。
                    if end > 200:
                        view = memoryview(buffer)[:end]
                        try:
                            self._bus.publish(view, self._width, self._height, "image/jpeg")
                        finally:
                            view.release()
                    del buffer[:end]
        finally:
            self.stop()
            if self._proc is not None and self._proc.poll() is None:
                try:
                    self._proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._proc.kill()


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


class SyntheticSource(threading.Thread):
    """无摄像头兜底：纯标准库生成移动色条的 PNG 画面。"""

    def __init__(self, bus: FrameBus, fps: int, width: int = 640, height: int = 360):
        super().__init__(name="synthetic-source", daemon=True)
        self._bus = bus
        self._fps = fps
        self._width = width
        self._height = height
        self._stop_event = threading.Event()
        self.kind = "synthetic"
        stride = width * 3 + 1
        base = bytearray()
        for y in range(height):
            base.append(0)  # PNG filter type 0
            row = bytearray(width * 3)
            for x in range(width):
                i = x * 3
                row[i] = (x * 255) // width
                row[i + 1] = (y * 255) // height
                row[i + 2] = 90
            base.extend(row)
        self._base_raw = bytes(base)
        self._stride = stride

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        interval = 1.0 / max(1, self._fps)
        frame_id = 0
        while not self._stop_event.is_set():
            began = time.perf_counter()
            raw = bytearray(self._base_raw)
            bar_width = 80
            bar_x = int((frame_id * 9) % max(1, self._width - bar_width))
            for y in range(self._height // 3, 2 * self._height // 3):
                start = y * self._stride + 1 + bar_x * 3
                raw[start : start + bar_width * 3] = b"\xff\x40\x80" * bar_width
            png = (
                PNG_SIGNATURE
                + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", self._width, self._height, 8, 2, 0, 0, 0))
                + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 1))
                + _png_chunk(b"IEND", b"")
            )
            self._bus.publish(png, self._width, self._height, "image/png")
            frame_id += 1
            time.sleep(max(0.0, interval - (time.perf_counter() - began)))


class FrameHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    bus: FrameBus
    source_kind: str
    port: int

    def log_message(self, fmt: str, *args) -> None:
        pass  # 帧服务日志太密集，静默处理

    def _reply(
        self,
        status: int,
        body: bytes = b"",
        content_type: str = "text/plain; charset=utf-8",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        path = urlparse(self.path).path
        if path == "/health":
            self._reply(200, b'{"ok":true}')
        elif path == "/frame":
            frame = self.bus.read()
            if frame is None:
                self._reply(503, b'{"error":"no frame yet"}', "application/json")
                return
            self._reply(
                200,
                frame["data"],
                frame["mime"],
                {
                    "X-Frame-Id": str(frame["id"]),
                    "X-Timestamp": str(frame["stamp"]),
                    "X-Width": str(frame["width"]),
                    "X-Height": str(frame["height"]),
                },
            )
        elif path == "/stats":
            info = self.bus.stats()
            info.update({"source": self.source_kind, "port": self.port})
            self._reply(
                200,
                json.dumps(info, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8",
            )
        elif path == "/stream":
            self._mjpeg_stream()
        else:
            page = (
                "<h1>Python frame server</h1>"
                "<p>/frame 单帧 · /stats 统计 · /stream MJPEG 流</p>"
            ).encode("utf-8")
            self._reply(200, page, "text/html; charset=utf-8")

    def _mjpeg_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Connection", "close")
        self.end_headers()
        last_id = -1
        try:
            while True:
                frame = self.bus.read()
                if frame is None or frame["id"] == last_id:
                    time.sleep(0.02)
                    continue
                last_id = frame["id"]
                chunk = (
                    b"--frame\r\n"
                    + b"Content-Type: "
                    + frame["mime"].encode("ascii")
                    + b"\r\n"
                    + b"Content-Length: "
                    + str(len(frame["data"])).encode("ascii")
                    + b"\r\n\r\n"
                    + frame["data"]
                    + b"\r\n"
                )
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Python 共享内存帧服务")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--width", type=int, default=0, help="摄像头请求宽度，0 表示默认")
    parser.add_argument("--height", type=int, default=0, help="摄像头请求高度，0 表示默认")
    parser.add_argument("--buffer-size-mb", type=int, default=8)
    parser.add_argument("--name", default=None, help="共享内存名称，None 则自动生成")
    parser.add_argument("--ffmpeg-bin", default=None, help="ffmpeg 路径，默认从 PATH 查找")
    parser.add_argument("--camera-name", default=None, help="ffmpeg 摄像头设备名，如 Integrated Camera")
    parser.add_argument(
        "--force-synthetic", action="store_true", help="强制使用合成画面，便于无摄像头测试"
    )
    parser.add_argument(
        "--no-http",
        action="store_true",
        help="不启动 HTTP 服务，只向共享内存发布帧（供 Electron 直接映射内存读取）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bus = FrameBus(args.name, args.buffer_size_mb * 1024 * 1024)
    source = None
    reason = ""

    def wait_first_frame(candidate: threading.Thread, seconds: float) -> None:
        candidate.start()
        deadline = time.time() + seconds
        while time.time() < deadline and bus.stats()["frame_id"] < 0:
            if not candidate.is_alive():
                raise RuntimeError(f"{candidate.kind} 采集线程退出")
            time.sleep(0.05)
        if bus.stats()["frame_id"] < 0:
            raise RuntimeError(f"{candidate.kind} 在 {seconds:g} 秒内没有产出画面")

    ffmpeg_bin = args.ffmpeg_bin or os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")

    if not args.force_synthetic:
        # 1) 优先用 ffmpeg 直接读摄像头
        if ffmpeg_bin:
            candidate = FFmpegCameraSource(
                bus, ffmpeg_bin, args.camera_name, args.fps, args.width, args.height
            )
            try:
                wait_first_frame(candidate, 8)
                source = candidate
            except Exception as exc:
                reason = f"ffmpeg 摄像头不可用: {exc}"
                candidate.stop()
        else:
            reason = "未找到 ffmpeg"

        # 2) 其次尝试 OpenCV
        if source is None and importlib.util.find_spec("cv2") is not None:
            candidate = CameraSource(bus, args.camera_index, args.fps, args.width, args.height)
            try:
                wait_first_frame(candidate, 4)
                source = candidate
            except Exception as exc:
                reason = f"{reason}；OpenCV 不可用: {exc}".strip("；")
                candidate.stop()

    # 3) 最后降级为合成画面
    if source is None:
        if not args.force_synthetic and not reason:
            reason = "未找到可用摄像头源"
        source = SyntheticSource(bus, args.fps)
        source.start()

    if reason:
        print(f"[python] fallback reason: {reason}", flush=True)

    if args.no_http:
        server = None
    else:
        FrameHandler.bus = bus
        FrameHandler.source_kind = source.kind
        FrameHandler.port = args.port
        server = ThreadingHTTPServer(("127.0.0.1", args.port), FrameHandler)
        server.daemon_threads = True

    cleaned = False

    def cleanup() -> None:
        nonlocal cleaned
        if cleaned:
            return
        cleaned = True
        source.stop()
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            server.server_close()
        bus.close()

    atexit.register(cleanup)

    info = bus.stats()
    if server is not None:
        print(
            f"[python] ready http://127.0.0.1:{args.port} "
            f"source={source.kind} shm={bus.name} buffer={info['buffer_bytes']} slots={info['slot_count']}x{info['slot_size']}",
            flush=True,
        )
    else:
        print(
            f"[python] ready (no-http) source={source.kind} "
            f"shm={bus.name} buffer={info['buffer_bytes']} slots={info['slot_count']}x{info['slot_size']}",
            flush=True,
        )
    if reason:
        print(f"[python] camera unavailable, using synthetic frames: {reason}", flush=True)
    try:
        if server is not None:
            server.serve_forever(poll_interval=0.2)
        else:
            # 纯共享内存模式：主线程只需保持存活，采集线程负责发布
            while source.is_alive():
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
