# Electron 摄像头 showcase

`shmring` 的**完整上层应用示例**：Python 采集摄像头画面，用库写进共享内存环形缓冲；Electron 主进程用同一个库直接读帧，渲染进程用 Canvas 实时显示。全程无 HTTP、无端口、无轮询请求。

这个 demo 想说明的是：**库只负责不透明字节帧的传输，业务语义由上层自己编码**。这里把 `width / height / mime` 放进每帧的 `meta`（紧凑 JSON），库完全不关心载荷是 JPEG、音频还是张量。

```text
ffmpeg（dshow MJPEG）/ OpenCV / 合成 PNG
        │  JPEG 字节（不透明 payload）
        ▼
python/server.py · FrameBus
        │  ShmRingWriter.publish(payload, meta='{"w":640,"h":360,"mime":"image/jpeg"}')
        ▼
OS 命名共享内存 · shmring v1（64B 全局头 + 4 槽，seqlock）
        │  ShmRingReader.readBatch()：一次扫描批量取走新帧，双检 seq
        ▼
main.js（Electron 主进程，每 2ms 扫一次）
        │  webContents.send() 结构化克隆
        ▼
renderer.js · ImageDecoder → Canvas.drawImage()
```

两端代码里**没有任何 struct 布局、FFI 或内存偏移计算**——这些都在库里。对比一下就知道抽层的价值：`main.js` 删掉了约 180 行 Win32/koffi/DataView 代码，`server.py` 删掉了约 140 行协议实现，只留一层约 100 行的图像语义适配。

## 运行

需要 Python ≥ 3.9（仅标准库）、Node ≥ 18、以及 PATH 中的 `ffmpeg`（没有摄像头时会自动回退到合成画面）。

```bash
# 1. 仓库根：安装库自身依赖（koffi）。shmring 的 FFI 后端从这里解析 koffi。
cd shmring
npm install

# 2. 本示例：安装 Electron，并把库作为本地依赖链接进来
cd examples/electron-camera
npm install
npm start
```

Electron 二进制下载慢时可用国内镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

> WorkBuddy 等会给 shell 注入 `ELECTRON_RUN_AS_NODE` 的环境里，需要 `env -u ELECTRON_RUN_AS_NODE npm start`，否则 Electron 以纯 Node 模式启动、不会出窗口。

启动后窗口显示实时画面，控制台每 2 秒打印一次：

```text
[electron] attached shmring_xxxxxxxx (8 MB, 4 slots, protocol v1), scanning every 2 ms
[shmring] frame #120 · 实际 30.4 fps · 帧龄 avg 1ms / max 3ms · 累计跳帧 0
```

界面右侧「延迟自检」会叠加毫秒秒表，用来肉眼核对端到端延迟；「暂停画面」只停绘制，Python 仍在采集。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEMO_FPS` | `20` | 采集帧率（ffmpeg 走摄像头原生模式时以设备实际帧率为准） |
| `DEMO_BUFFER_MB` | `8` | 段容量（MB），均分为 4 槽；单槽需能容纳最大单帧 |
| `DEMO_FORCE_SYNTHETIC` | 未设置 | 设为 `1` 强制合成画面，无摄像头也能跑 |
| `PYTHON` | 自动探测 | 指定 Python 解释器 |
| `FFMPEG_BIN` | PATH 中的 `ffmpeg` | 指定 ffmpeg 路径 |

### 不启动 Electron，单独验证读端

```bash
# 终端 A：Python 写端（合成画面，不占摄像头）
python python/server.py --no-http --name shmring_demo --force-synthetic

# 终端 B：Node 读端，读一帧并存成图片
node node-shm-reader.js shmring_demo out.jpg
```

`node-shm-reader.js` 只有几十行，全部靠 `ShmRingReader.read()`，是「库怎么用」的最小示范。Python 端也可以单独跑 HTTP 调试服务（去掉 `--no-http`），提供 `/frame`、`/stats`、`/stream`。

## 为什么这样分层

| 关心的事 | 谁负责 |
| --- | --- |
| magic / version / endianness / capacity 校验 | 库 |
| 4 槽环形覆盖、按帧号取模、seqlock 奇偶状态机 | 库 |
| 一次扫描批量读取 + 双检 + `dropped` 计数 | 库 |
| Win32 `CreateFileMappingW` / POSIX `shm_open+mmap`、段名归一化 | 库 |
| 规避 Electron 内置 Node 下 `koffi.view()` 崩溃（统一 `address+memcpy`） | 库 |
| `width/height/mime` 编码与解析 | 本示例（每帧 meta） |
| 摄像头采集、JPEG/PNG 编码、Canvas 解码绘制 | 本示例 |

换句话说：**换一个业务场景不用改库**。把 `meta` 换成音频采样率或张量 shape，`payload` 换成 PCM 或 float32 数组，传输层一行都不用动。

## 性能与边界

本机（Windows、ffmpeg dshow MJPEG 640×360）实测：稳定 **30 fps、帧龄 avg 1ms / max 3ms、累计跳帧 0**；CDP 验证渲染端 2.2 秒推进 68 帧，Canvas 640×360、像素正常、`mime=image/jpeg`。

肉眼感觉到的 100~200 ms 延迟几乎全部来自**摄像头曝光 + ISP + USB + dshow 驱动缓冲**，软件链路只有几毫秒。想再压低要从采集侧下手（补光、降分辨率、换低延迟摄像头），继续优化传输层没有意义。

库自身的限制见仓库根 [README.md](../../README.md) 与 [PROTOCOL.md](../../PROTOCOL.md)：这一示例用的是 v1，一段一个写者，x86/x64 内存序在 Windows 上验证过，ARM 未验证。读者落后超过 4 帧会计入 `dropped`。Linux/macOS 在 CI 矩阵里，最近的 run 没有通过，本机未实测。
