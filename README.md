# shmring

**跨语言、无锁的共享内存环形帧总线**：单写者、多读者，零 HTTP、零轮询请求、零互斥量。

Python 写、Node/Electron 读（或反过来），两端直接映射同一块 OS 命名共享内存。`shmring` 把这条链路里最值得复用的部分——**内存布局 + seqlock + 环形覆盖 + 平台适配**——抽成了一个独立库，业务数据只是不透明字节。

> 状态：`v0.1.0` 已发布到 **PyPI**（`pip install shmring`）；npm 首个版本待发布，
> 当前 Node 侧请从源码使用 `npm install`（见下文）。协议见 [PROTOCOL.md](PROTOCOL.md)。

## 为什么需要它

一个常见场景：Python 负责采集/推理，Electron 负责展示。用 HTTP 传帧要付协议栈、序列化、轮询和背压的代价；直接读共享内存则只要一次 `memcpy`。但真正难的不是「读」，是**两边节奏不对齐时如何不撕裂、不丢帧、不堆积延迟**：

- 写者可能在 0.01 ms 内连发数帧，读者每 2 ms 才扫一次 → 单槽必被覆盖；
- 用队列缓冲则读者卡顿时旧帧越积越多，延迟越滚越大；
- 不加锁又读到写了一半的槽，就会拿到垃圾数据。

`shmring` 的答案是 **N 槽环形缓冲 + 显式 seqlock**：按帧号取模复用固定槽位，只保留最近 N 帧；写者用奇偶序号声明「写入中 / 已完成」；读者一次扫描批量取走所有新帧，读完双检序号。谁都不等谁，也不需要握手。

## 特性

| | |
| --- | --- |
| 传输 | OS 命名共享内存直连，无端口、无协议栈、无轮询请求 |
| 同步 | 显式 seqlock，无互斥量 / 条件变量 / 系统调用 |
| 拓扑 | 单写者、多读者；读者各有独立游标 |
| 语义 | 最近 N 帧的**窗口**，不是队列；宁丢旧帧，不堆积延迟 |
| 载荷 | 不透明字节 + 可选 meta 字节，库不解析、不假定编码 |
| 平台 | Windows / Linux / macOS；Node 侧用 `koffi` 纯 JS FFI，**无需 node-gyp 或 C++ 插件** |
| 协议 | 固定小端、带 magic/version/endianness/capacity 校验，跨语言版本可协商 |

## 适用场景与不适用

`shmring` 是**同机、跨语言、最新优先的帧缓存**，不是通用消息队列，也不是零拷贝传输。它保存的是「最近 N 帧的**窗口**」而非队列（[PROTOCOL.md](PROTOCOL.md) 第 1 节）：写者从不等待读者，读者落后超过 `slot_count` 帧时旧帧已被覆盖，**且无法补回**——`dropped` 只是事后报告。把它当成通用内存交换通道是最常见的误用。

### 判定标准

同时满足三条才适合直接使用：

1. **每帧自包含**：丢掉第 k 帧后，第 k+1 帧仍能独立解释，不依赖前后帧拼接或累积状态。
2. **最新优先**：业务上「现在的状态」比「完整历史」重要。
3. **可静默丢**：接受丢帧只需报告，不需要告警、重试或补录。

缺第 3 条 → 按下面「改造后可用」处理；缺第 1 或第 2 条 → 换方案。

### 直接使用（甜点区）

| 场景 | 为什么合适 |
| --- | --- |
| 摄像头 / 多路视频墙实时预览 | 每帧是完整画面；仓库内两个 showcase 已验证 30fps / 帧龄 1ms / 丢帧 0 |
| 屏幕采集、远程画面预览 | 同上 |
| 推理结果可视化：检测框、mask、热力图、骨架 | 每帧独立成图，只看当前结果 |
| 雷达 / 深度图 / 点云的当前帧快照 | 同上 |
| 遥测仪表盘的最新值快照 | 只要当前值，历史由别处落盘 |
| 音频频谱图、波形快照 | 展示用途，不是录音 |

### 改造后可用

高频连续流（EEG / EMG / IMU / 振动 / PCM / 日志事件）**只做实时显示、趋势或频谱**时可以借用本库，但库不提供完整性语义，必须自己补：

- 按固定样本数聚成 **block**（如 500Hz × 64ch 聚成 20ms 一块 → 50fps），不要按单个样本 `publish()`；默认 4 槽在 1000Hz 下只有 4ms 容错窗口。
- payload 自带 **block 序号 + 样本起始序号 + CRC32**；读端用 `readBatch()` 检查序号连续性，`dropped > 0` 立刻重同步，绝不静默插值。槽头的 `checksum` 在 v1 写 0、读者不校验。
- `stamp` 是 Unix 毫秒且「仅用于诊断、允许时钟回拨」，不要当采样时基；时基要用自己的样本计数器。
- `slot_count` 按可容忍的落后时间配（如 256 槽 @50fps ≈ 5s 窗口），别用默认 4。
- **存盘必须独立做**：段是纯内存，进程退出即消失，不能当记录介质。

### 不适用

| 场景 | 应该用什么 |
| --- | --- |
| 科研 / 临床记录、ERP、模型训练集（一个样本都不能丢） | 无损 SPSC 环形队列 + 落盘；生理信号可看 Lab Streaming Layer (LSL) |
| 可靠投递：确认、重试、背压、消费位点 | ZeroMQ / Redis Streams / Kafka / NATS |
| 任务队列、事件溯源、日志归档 | 同上 |
| 大文件、批量数据搬运 | 文件 / mmap；默认几何下单帧上限约 2MB |
| 多写者、严格全局顺序、事务 | v1 协议级禁止多写者（见下文「限制」） |
| 跨机器传输 | 本库只用 OS 命名共享内存，同机限定 |
| ARM / 弱内存序平台 | v1 无内存屏障，仅限 x86/x64 小端 |
| 无人值守长稳、崩溃恢复、写者存活检测 | v1 无 heartbeat / epoch，见下文「限制」与路线图 |
| 安全隔离 / 多租户 | 命名段无认证，同名可被抢先创建并伪造 magic |

一句话：它擅长**「现在这一帧」**，不擅长「所有帧」，更不擅长「一帧都不能少」。

## 安装

```bash
# Python 端（PyPI 已发布）
pip install shmring

# 从源码开发：仓库根
pip install -e .
npm install        # Node 端依赖 koffi；npm 包发布后可直接 npm install shmring
```

依赖：Python ≥ 3.9（仅标准库）；Node ≥ 18 + `koffi ^3.3.8`。

## 快速开始

### Python 写 → Node 读

```python
# writer.py
from shmring import ShmRingWriter

w = ShmRingWriter("demo", capacity=8 * 1024 * 1024)  # 4 槽，每槽 meta 256B
w.publish(b"\xff\xd8...jpeg bytes...", meta=b'{"mime":"image/jpeg"}')
# 进程需要保持存活，段才存在
```

```js
// reader.js
const { ShmRingReader } = require('shmring');

const r = new ShmRingReader('demo');
const f = r.read();                    // 最新一帧
console.log(f.frameId, f.payload, f.meta.toString());

const batch = r.readBatch();           // 自上次以来的所有新帧
console.log(batch.frames.length, batch.dropped);
r.detach();
```

### 反向（Node 写 → Python 读）

```js
const { ShmRingWriter } = require('shmring');
const w = new ShmRingWriter('demo2');
w.publish(Buffer.from('hello'), Buffer.from('topic=a'));
```

```python
from shmring import ShmRingReader
with ShmRingReader("demo2") as r:
    print(r.read().payload)            # b'hello'
```

[`examples/`](examples/) 下有 4 个最小读写脚本，以及两个完整的 Electron showcase（单路摄像头、5 路并发合成帧）；跨语言对拍脚本见 `node scripts/interop.js`，多段并发基准见 `python scripts/bench_multi.py`。

## Showcase：Electron 摄像头实时画面

[`examples/electron-camera/`](examples/electron-camera/) 是本库的**完整上层应用**：Python 用 ffmpeg 采集摄像头，`ShmRingWriter` 写帧；Electron 主进程 `ShmRingReader.readBatch()` 批量读帧，渲染进程用 Canvas 实时显示。无 HTTP、无端口、无轮询。

它演示了库的核心取舍：**库只传不透明字节，业务语义由应用自己编码**。这里把 `width / height / mime` 放进每帧 `meta`（紧凑 JSON），库完全不关心载荷是 JPEG、PCM 还是张量。两端代码里没有任何 struct 布局、内存偏移或 FFI 调用——这些都被收进库里了。

```text
ffmpeg MJPEG → ShmRingWriter.publish(jpeg, meta)
             → OS 命名共享内存（4 槽 + seqlock）
             → ShmRingReader.readBatch()
             → Electron IPC → ImageDecoder → Canvas
```

运行方式见 [该目录 README](examples/electron-camera/README.md)。本机（Windows，640×360 MJPEG）实测 **30 fps、帧龄 avg 1ms、累计跳帧 0**；CDP 验证渲染端画面与 `meta` 往返正确。

### 5 路并发：一路一段

[`examples/electron-multi-camera/`](examples/electron-multi-camera/) 是第二档 showcase：一个 Python 进程开 5 个 `ShmRingWriter` 各写各的命名段，Electron 用**一个** 2ms 循环遍历 5 个 reader、一次批量 IPC、5 宫格渲染，全部用合成帧，不依赖摄像头。

它演示的是「同一进程内多个 writer 实例互不干扰」——帧号、`seq`、槽几何、线程锁全部实例隔离，一路卡住不影响其余四路。配套 [`scripts/bench_multi.py`](scripts/bench_multi.py) 的实测：限速 30fps/路时 5 路合计 **147.2 fps、丢帧 0、帧龄 avg 1.41ms**；不限速纯 publish 达到 133638 fps（5473.8 MB/s），5 路 / 1 路 = 0.76×，说明 CPython 下 GIL 使同进程多线程没有并行加速，但也证明传输层远不是瓶颈。详见 [该目录 README](examples/electron-multi-camera/README.md)。

## API

### Python

| 对象 | 方法 / 属性 | 说明 |
| --- | --- | --- |
| `ShmRingWriter(name, capacity, slot_count, meta_capacity, replace=False)` | `publish(payload, meta=b"", stamp=None) -> frame_id` | 写一帧，返回帧号；`payload`/`meta` 支持 buffer protocol |
| | `info`, `payload_capacity`, `meta_capacity` | 布局信息 |
| | `close()`, `unlink()`, 上下文管理器 | `unlink()` 删除 OS 对象（Windows 为 no-op） |
| `ShmRingReader(name, retries=8)` | `read() -> Frame \| None` | 最新完整帧；`Frame(frame_id, stamp, payload, meta, seq)` |
| | `read_batch(since=None) -> Batch` | `Batch(frames, dropped, newest)`；`since=None` 用自身游标 |
| | `info`, `last_frame_id`, `close()` / `detach()` | |
| 模块级 | `unlink(name)`, `normalize_name(name, for_posix)` | 清理残留段 / 名字归一化 |

### Node

| 对象 | 方法 / 属性 | 说明 |
| --- | --- | --- |
| `new ShmRingWriter(name, {capacity, slotCount, metaCapacity})` | `publish(payload, meta, stamp?) -> frameId` | 载荷为 Buffer / Uint8Array / string |
| | `info`, `payloadCapacity`, `metaCapacity` | |
| | `close()`, `unlink()` | |
| `new ShmRingReader(name, {retries})` | `read() -> {frameId, stamp, payload, meta, seq} \| null` | Buffer 载荷 |
| | `readBatch(since?) -> {frames, dropped, newest}` | |
| | `info`, `lastFrameId`, `close()` / `detach()` | |
| 模块级 | `unlink(name)`, `normalizeName(name, forPosix)` | |

错误类型：两端都提供 `ProtocolError` / `SegmentNotFound` / `CapacityError` / `ShmRingError`（Node 另有 `SegmentExists`）。

## 平台支持状态

| 平台 | Python 后端 | Node 后端 | 验证情况 |
| --- | --- | --- | --- |
| Windows | `multiprocessing.shared_memory` → `CreateFileMapping` | `OpenFileMappingW` / `CreateFileMappingW` + `MapViewOfFile`（koffi） | **本机实测通过**：双向跨语言对拍、单测全绿 |
| Linux | 同上 → `shm_open` | `libc.so.6`：`shm_open` / `ftruncate` / `mmap`（koffi） | 由 CI 矩阵覆盖，**本机未实测** |
| macOS | 同上 → `shm_open` | `libSystem.B.dylib`（含 31 字节段名限制、Darwin `O_CREAT` 常量） | 由 CI 矩阵覆盖，**本机未实测** |

平台差异由库内部消化：POSIX 段名自动加前导 `/`；Python 3.8–3.12 的 `resource_tracker` 误删问题在 attach 时 `unregister`（3.13+ 用 `track=False`）。

> 已知坑：Node 侧**不要**用 `koffi.view()` 把映射地址包成零拷贝视图——在 Electron 内置 Node 下会触发 `napi_is_detached_arraybuffer` FATAL ERROR。库内部统一用 `koffi.address()` + `memcpy` 复制到独立 Buffer。

## 限制

1. **单写者**：多个进程同时 `publish()` 会破坏 seqlock，v1 不支持。
2. **内存序**：依赖 8 字节对齐读写的原子性与写顺序，x86/x64 保证；ARM 等弱内存序平台未验证。
3. **容量**：`capacity` 用 `uint32` 存储，上限 4 GiB − 1。
4. **丢帧**：读者落后超过 `slot_count` 帧，旧槽已被覆盖，会跳过并计入 `dropped`（设计取舍）。
5. **`replace` 语义差异**：POSIX 上是「删名重建」；Windows 无法 `shm_unlink`，改为「重新 attach 并在原位重置」，要求几何参数一致，且调用方须确保没有活跃写者。
6. `stamp` 仅用于帧龄诊断，允许时钟回拨，不参与正确性判断。

## 测试

```bash
python -m unittest discover -s tests -v   # Python 单测
npm test                                   # Node 单测（node --test）
node scripts/interop.js                    # 跨语言双向对拍
python scripts/bench_multi.py              # 1 路 vs 5 路并发基准
python scripts/verify_multi.py             # 5 段跨语言端到端验证
```

CI 在 `ubuntu-latest` / `macos-latest` / `windows-latest` 三个平台跑完整矩阵，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## 路线图

- [x] 发布 `shmring` 0.1.0 到 PyPI（2026-11-22）
- [ ] 发布到 npm（首版需人工认证，之后可配 Trusted Publisher 免 token）
- [ ] Node 端补 `replace` / 重置已有段能力（目前仅 Python 端提供）
- [ ] ARM / 弱内存序平台的屏障验证
- [ ] 可选的 CRC32 校验（槽头已预留 `checksum` 字段）
- [ ] Rust / C 参考实现，进一步证明协议语言无关

## 协议与许可

完整线上格式、状态机、校验规则与兼容性承诺见 [PROTOCOL.md](PROTOCOL.md)。修改协议必须提升 `VERSION`。

MIT © 2026 meta_codes
