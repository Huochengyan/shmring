# 5 路并发 showcase（合成帧）

`shmring` 的**多段并发示例**：一个 Python 进程同时开 5 个 `ShmRingWriter`，各写各的命名段；Electron 主进程用**一个** 2ms 循环遍历 5 个 `ShmRingReader`，把这一轮 5 路的帧打包成**一次** IPC，渲染进程 5 宫格显示。全程无 HTTP、无端口、无摄像头依赖。

它要证明的是：**库没有进程级可变全局状态，同一进程内 N 个 writer 实例各写各的段，帧号 / seq / 槽几何 / 线程锁全部实例隔离**。这也是"5 个摄像头、5 个不同内存 id"这类场景的正确做法——一路一段，各自独立的 4 槽窗口和丢帧计数，某一路卡住不挤占其余四路。

```text
FrameFactory（启动预生成 5×8 张有效 PNG，运行期只查表）
        │  每路一个线程，30 fps
        ▼
Channel(k).writer.publish(png, meta={"cam":k,"w":640,"h":360,"mime":"image/png"})
        ▼
OS 命名段 shmring_multi_<hex>_1..5   （各自 64B 头 + 4 槽 + seqlock）
        ▼
main.js：一个 setInterval(2ms) 循环 → 5 × readBatch() → 一次 webContents.send('frames', [...])
        ▼
renderer.js：按 camId 分发 → 每路串行绘制链 → 全局最多 3 个 ImageDecoder 并发 → 5 个 Canvas
```

两端代码里没有任何 struct 布局、FFI 或内存偏移计算。`cam_id / w / h / mime` 由每帧 `meta` 携带，库只看到不透明字节。

## 运行

需要 Python ≥ 3.9（仅标准库）、Node ≥ 18。**不需要摄像头和 ffmpeg**。

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

启动后窗口是 5 宫格，控制台每 2 秒打印一次：

```text
[electron] attached 5 segments (512 KB each, 4 slots, protocol v1), one 2ms loop scanning all readers
[renderer] 5 个 Canvas 首帧绘制完成 · 中心像素非黑 5/5
[shmring] cams=5 fps=[29.5,29.4,29.5,29.4,29.4] total=147.2 · 帧龄 avg 1ms · 累计跳帧 0 · 离线 0
```

渲染端会做一次首帧自检：5 个 Canvas 各自首次 `drawImage()` 后采样中心像素并回报主进程，用来确认画面真的上屏，而不只是 IPC 送达。

右侧「逐路状态」分别显示每路的 fps / 帧号 / 累计跳帧 / 在线状态；某路超过 2 秒没有新帧会标记为离线（对应前述"写者存活检测"缺口，示例里用 `stamp` 超时做了兜底）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEMO_CAMS` | `5` | 并发路数 / 段数 |
| `DEMO_FPS` | `30` | 每路目标帧率 |
| `DEMO_BUFFER_KB` | `512` | 每段容量 KB；Python 侧会按实际最大帧自动提升到安全下限 |
| `PYTHON` | 自动探测 | 指定 Python 解释器 |
| `DEMO_AUTO_QUIT_MS` | 未设置 | 无人值守冒烟：到点自动 `app.quit()`，正常关 reader / Python |

段名是 `shmring_multi_<随机 hex>_1..N`，每次启动都不同，避免与上次崩溃残留的段撞名。

### 单独跑写端 / 跑 benchmark

```bash
# 只启动 Python 写端（打印 READY 与每路 fps）
python python/server.py --cam-count 5 --fps 30 --buffer-kb 512

# 库级多段并发 benchmark（1 路 vs 5 路）
python ../../scripts/bench_multi.py
python ../../scripts/bench_multi.py --quick          # CI 冒烟
python ../../scripts/bench_multi.py --cam-counts 1,3,5 --frame-bytes 81920

# 跨语言多段端到端验证：5 路 Python 写 → 5 个 Node reader 读，校验 PNG/meta/cam_id
python ../../scripts/verify_multi.py
```

## Benchmark 实测

环境：Windows / CPython / `shmring 0.1.0` / 协议 v1，每帧 40960 B，每路 4 槽，5 段合计 823 KB 共享内存。命令 `python scripts/bench_multi.py`（限速场景 3s，不限速场景 2s）。

**A. 限速 30 fps/路 + 单个 2ms 扫描线程（模拟 Electron 主进程）**

| 路数 | 合计发布 fps | 吞吐 | publish p50 / p99 | 读到帧 | 丢帧 | 帧龄 avg / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 29.5 | 1.21 MB/s | 34.1 / 133.7 µs | 89 | 0 | 1.28 / 3 ms |
| 5 | 147.2 | 6.03 MB/s | 29.6 / 67.0 µs | 445 | 0 | 1.41 / 3 ms |

5 路合计恰好是 1 路的 ~5×，**丢帧 0、帧龄仍在 1~3ms**，说明多路并发下 seqlock 与环形缓冲互不干扰。

**B. 不限速纯 publish（无 reader，测库本身的 memcpy 上限）**

| 路数 | 合计发布 fps | 吞吐 | publish p50 / p99 |
| --- | --- | --- | --- |
| 1 | 175359 | 7182.7 MB/s | 4.5 / 8.0 µs |
| 5 | 133638 | 5473.8 MB/s | 4.7 / 11.3 µs |

这个数字是"只做 memcpy、不采集不编码不渲染"的理论上限，用来说明**传输层不是瓶颈**。5 路 / 1 路 = **0.76×**：CPython 下 `publish()` 的 memcpy 不释放 GIL，同进程多线程没有并行加速，线程切换还带来约 24% 损耗。要按路数线性扩容应改成多进程（每段一个写者进程）；如果只是多路逻辑隔离，当前多线程方案完全够用。

> A 场景的 reader 是同一进程内的扫描线程（同样受 GIL）；真实部署里 reader 在 Electron 另一个进程，读侧完全并行。

### 端到端 Electron 冒烟（合成帧）

`DEMO_AUTO_QUIT_MS=9000 npm start` 无人值守跑 9 秒，实测：

- 5 段全部 attach 成功，每段 512 KB / 4 槽 / 协议 v1；
- 稳态每路 29.5 fps，合计 **147.5 fps**，帧龄 avg **1ms**，累计跳帧 **0**，离线 **0**；
- 渲染端首帧自检 **5/5 个 Canvas 中心像素非黑**，5 宫格正常出画面；
- `app.quit()` 走 `before-quit`，5 个 reader 与 Python 子进程均正常回收，无残留 electron / ffmpeg 进程。

与 Python 侧 benchmark 的 A 场景吻合（147.2 vs 147.5 fps），说明 5 路并发下库的读写两侧都没有额外损耗。

## 换成真实摄像头时要注意

这个示例刻意用合成帧，把变量收敛到库本身。接 5 个真实摄像头时，**瓶颈会整个移到采集侧**：

- **USB 带宽**：5 个摄像头挂同一个 hub，640×360 MJPEG @30fps 合计 5–12MB/s，USB 2.0 实际吞吐有限，常见掉帧 / 被降帧率 / 打不开设备。分散到不同根控制器、必要时降分辨率，坚持 MJPEG 而非 YUYV。
- **CPU**：5 路 ffmpeg 解码+缩放+重编码，以及渲染端 5 路 PNG/JPEG 解码，才是主要开销。
- **容量**：每段按最大单帧 ×4 槽估算即可（默认 512KB/段，脚本会自动兜底），不必沿用单路示例的 8MB/段。
- **崩溃清理**：Windows 段随最后一个句柄关闭回收；POSIX 上进程被强杀会残留段，随机前缀只保证不撞名，生产环境仍需按名字批量 `unlink()`。

库自身的限制见仓库根 [README.md](../../README.md) 与 [PROTOCOL.md](../../PROTOCOL.md)：v1 单写者、x86/x64 内存序已验证（ARM 未验证）、读者落后超过 `slot_count` 帧会计入 `dropped`、Linux/macOS 后端由 CI 覆盖但未在本机实测。
