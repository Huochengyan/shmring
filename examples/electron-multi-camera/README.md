# 5 路并发 showcase

一个 Python 进程开 5 个视频 `ShmRingWriterV2`（overwrite），再加一段时序。Electron 一个循环扫这些 `ShmRingReaderV2`。

默认带 `--real-camera`：第 1 路是 ffmpeg 读到的 JPEG。没有 ffmpeg 或摄像头时，这一路退回合成 PNG，控制台打印 `real-camera=no`。设 `DEMO_REAL_CAMERA=0` 可关掉。无头校验不传这个参数：

```bash
python scripts/verify_multi.py
```

左侧菜单是「视频」和「时序数据」。视频是 5 段，时序另起一段。主进程用一个 `setTimeout` 扫全部 reader，间隔在界面上改，1–5000 ms，默认 2 ms。全程无 HTTP、无端口。

它要证明的是：**库没有进程级可变全局状态，同一进程内 N 个 writer 实例各写各的段，帧号 / seq / 槽几何 / 线程锁全部实例隔离**。一路一段，各自独立的 4 槽窗口和丢帧计数，某一路卡住不挤占其余路。

```text
视频（5 段，overwrite，1024 字节头，4 槽）
  第 1 路：npm start 传 --real-camera，ffmpeg MJPEG；失败则合成 PNG
  第 2–5 路：合成 PNG
        │  每路一个线程
        ▼
  ShmRingWriterV2.publish(frame, meta={cam,w,h,mime,src})
        ▼
时序（另一段，1 MiB，4 槽）
  160 导 × 512 Hz，每包 8–32 个采样，交错 float32
  meta={kind:series, hz, ch, n, i0}
        ▼
main.js：一个 setTimeout（默认 2ms）
  视频：readBatch → commit；Gap 则 skipTo → 一次 send('frames')
  时序：同样 commit / skipTo → send('series')，payload 保持 Buffer
        ▼
renderer.js：视频按 cam 画到 5 个 Canvas
             时序在「时序数据」页按像素列抽 min/max，窗口 4 / 10 / 20 秒
```

两端业务代码里没有自己的 struct 布局。`cam / w / h / mime / src` 和时序的 `hz / ch / n / i0` 都在每帧 `meta` 里，库只看到不透明字节。

## 运行

需要 Python ≥ 3.9（仅标准库）、Node ≥ 18。`npm start` 会尝试第 1 路摄像头；没有 ffmpeg 或设备时这一路退回合成 PNG，另外四路一直是合成帧。只想看合成画面时设 `DEMO_REAL_CAMERA=0`。

```bash
# 1. 仓库根：安装库自身依赖（koffi）
cd shmring
npm install

# 2. 本示例
cd examples/electron-multi-camera
npm install
npm start
```

Electron 下载慢时可用国内镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

> WorkBuddy 等会给 shell 注入 `ELECTRON_RUN_AS_NODE` 的环境里，需要 `env -u ELECTRON_RUN_AS_NODE npm start`，否则 Electron 以纯 Node 模式启动、不出窗口。

启动后窗口标题是「视频与时序」。视频页是 5 宫格，时序页是 160 条曲线。控制台先打连接行，之后大约每 2 秒打一行视频统计：

```text
[electron] attached 5 segments (<容量> KB each, 4 slots, protocol v2), one 2ms loop scanning all readers
[renderer] 5 个 Canvas 首帧绘制完成 · 中心像素非黑 5/5
[shmring] cams=5 fps=[...] total=... · 帧龄 avg ...ms · 累计跳帧 ... · 离线 ...
```

fps 随机器和读取间隔变化，上面不填某一次的数字。渲染端会做一次首帧自检：5 个 Canvas 各自首次 `drawImage()` 后采样中心像素并回报主进程。

视频页右侧是合计帧率、帧龄、累计跳帧，以及逐路 fps / 帧号 / 跳帧 / 在线。某路超过 2 秒没有新帧会标为离线，这一判断用的是帧的 `stamp`。时序页右侧是采样率、导联、最近一包、吞吐、绘制耗时、包序号、采样号、丢包。160 条曲线按像素列抽点，吞吐和丢包按环里的完整 payload 算。显示窗口默认 10 秒，可切 4 秒或 20 秒。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEMO_CAMS` | `5` | 视频路数 / 段数。时序段另计，不在这个数里 |
| `DEMO_FPS` | `30` | 每路视频的目标帧率 |
| `DEMO_BUFFER_KB` | `512` | 每路视频的容量 KB。Python 会按最大帧抬到安全下限。时序段固定 1 MiB |
| `DEMO_REAL_CAMERA` | 开启 | 设为 `0` 时 Electron 不传 `--real-camera` |
| `PYTHON` | 自动探测 | 指定 Python 解释器 |
| `DEMO_AUTO_QUIT_MS` | 未设置 | 无人值守冒烟：到点自动 `app.quit()` |

段名是 `shmring_multi_<随机 hex>_1..N`，每次启动都不同，避免与上次崩溃残留的段撞名。

### 单独跑写端 / 跑 benchmark

```bash
# 只启动 Python 写端（打印 READY 与每路 fps）
python python/server.py --cam-count 5 --fps 30 --buffer-kb 512

# 库级多段并发 benchmark（1 路 vs 5 路）
python ../../scripts/bench_multi.py
python ../../scripts/bench_multi.py --quick          # CI 冒烟
python ../../scripts/bench_multi.py --cam-counts 1,3,5 --frame-bytes 81920

# 跨语言多段端到端验证：5 路合成 PNG，不打开摄像头，不启时序段
python ../../scripts/verify_multi.py
```

直接跑 `python python/server.py` 时默认五路合成帧，且没有时序段。摄像头要自己加 `--real-camera`，时序要加 `--series-name`。这两项 `npm start` 会带上。

## Benchmark 实测（v1）

2026-11-24 在本机跑的 `python scripts/bench_multi.py`。脚本仍使用 v1 的 `ShmRingWriter`，不是五路窗口里的 v2。

环境：Windows 10.0.26300，CPython 3.10.11，Intel64 Family 6 Model 151，`shmring 0.2.0`，协议 v1。每帧 40960 B，每路 4 槽，每段 168640 字节，5 段合计 823 KB。限速场景约 3 秒，不限速场景约 2 秒。

**A. 目标 30 fps/路 + 单个 2ms 扫描线程**

| 路数 | 合计发布 fps | 吞吐 | publish p50 / p99 | 读到帧 | 丢帧 | 帧龄 avg / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 21.2 | 0.87 MB/s | 40.7 / 128.7 µs | 64 | 0 | 9.56 / 17 ms |
| 5 | 106.7 | 4.37 MB/s | 18.7 / 107.6 µs | 325 | 0 | 9.46 / 17 ms |

5 路合计是 1 路的 5.03×，每路都在 21.3 fps 左右，**丢帧 0**。没到设定的 30 fps：脚本用 `time.sleep` 等下一帧，这台 Windows 的睡眠粒度大约 15.6 ms，`sleep(33ms)` 实际更接近 47 ms。不限速的 B 场景说明环本身远高于 30 fps。

**B. 不限速纯 publish（无 reader）**

| 路数 | 合计发布 fps | 吞吐 | publish p50 / p99 |
| --- | --- | --- | --- |
| 1 | 245924 | 10073.05 MB/s | 3.3 / 6.2 µs |
| 5 | 145448 | 5957.55 MB/s | 4.1 / 11.0 µs |

这是只做 memcpy、不采集不编码不渲染的上限。5 路 / 1 路 = **0.59×**（145448 / 245924）。CPython 下 `publish()` 的 memcpy 不释放 GIL，同进程多线程没有并行加速，线程切换大约损耗 41%。要按路数线性扩容应改成多进程（每段一个写者进程）；只做多路逻辑隔离时，多线程够用。

> A 场景的 reader 是同一进程内的扫描线程（同样受 GIL）；真实部署里 reader 在 Electron 另一个进程，读侧完全并行。

### 端到端 Electron 冒烟（合成帧，v1 时期）

下面是改成 v2、加上时序页之前的一次 9 秒冒烟（`DEMO_AUTO_QUIT_MS=9000 npm start`）：

- 5 段全部 attach 成功，每段 512 KB / 4 槽 / 协议 v1；
- 稳态每路 29.5 fps，合计 **147.5 fps**，帧龄 avg **1ms**，累计跳帧 **0**，离线 **0**；
- 渲染端首帧自检 **5/5 个 Canvas 中心像素非黑**，5 宫格正常出画面；
- `app.quit()` 走 `before-quit`，5 个 reader 与 Python 子进程均正常回收，无残留 electron / ffmpeg 进程。

这是改 v2 之前的 Electron 冒烟，和上面 2026-11-24 的 `bench_multi.py` 不是同一次运行。当时每路大约 30 fps。

## 真实摄像头

`npm start` 只让第 1 路尝试真实摄像头，另外四路保持合成 PNG。设备或 ffmpeg 不可用时，第 1 路单独退回合成帧，不停下其余路。五路都接真实摄像头时，瓶颈在采集侧：

- **USB 带宽**：5 个摄像头挂同一个 hub，640×360 MJPEG @30fps 合计 5–12MB/s，USB 2.0 实际吞吐有限，常见掉帧 / 被降帧率 / 打不开设备。分散到不同根控制器、必要时降分辨率，坚持 MJPEG 而非 YUYV。
- **CPU**：5 路 ffmpeg 解码+缩放+重编码，以及渲染端 5 路 PNG/JPEG 解码，才是主要开销。
- **容量**：每段按最大单帧 ×4 槽估算即可（默认 512KB/段，脚本会自动兜底），不必沿用单路示例的 8MB/段。
- **崩溃清理**：Windows 段随最后一个句柄关闭回收；POSIX 上进程被强杀会残留段，随机前缀只保证不撞名，生产环境仍需按名字批量 `unlink()`。

库自身的限制见仓库根 [README.md](../../README.md) 与 [V2_DESIGN.md](../../V2_DESIGN.md)：这一示例用 v2，一段一个写者。读者落后超过 `slot_count` 帧得到 `Gap`。Windows 上本机跑过；Linux/macOS 在 CI 矩阵里，最近的 run 没有通过。
