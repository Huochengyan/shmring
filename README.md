# shmring

**跨语言共享内存环形帧总线**：单写者、多读者，零 HTTP、零轮询请求。跨进程用 seqlock，不拿互斥量。

Python 写、Node/Electron 读（或反过来），两端直接映射同一块 OS 命名共享内存。`shmring` 把这条链路里最值得复用的部分——**内存布局 + seqlock + 环形覆盖 + 平台适配**——抽成了一个独立库，业务数据只是不透明字节。

> 状态：仓库是 `v0.2.0`（v1 与 v2）。PyPI 上仍是 `0.1.0`，`pip install shmring` 得到的是 v1。
> 要用 0.2.0，在仓库根执行 `pip install -e .`。npm 尚未发布，Node 侧从源码 `npm install`。
> v1 见 [PROTOCOL.md](PROTOCOL.md)，v2 见 [V2_DESIGN.md](V2_DESIGN.md)。

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
| 同步 | 跨进程 seqlock，无条件变量。同一进程里 Python 的 `publish()` 用线程锁串行 |
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
- payload 自带 **block 序号 + 样本起始序号**。v1 槽头 `checksum` 写 0、读者不校验。v2 默认对 meta 再 payload 做 CRC32，不符抛 `ChecksumError` 且不推进游标。读端仍要用自己的序号检查连续性，`dropped > 0` 立刻重同步。
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
| 多写者、严格全局顺序、事务 | v1 和 v2 都是一段一个写进程（见下文「限制」） |
| 跨机器传输 | 本库只用 OS 命名共享内存，同机限定 |
| 把 v1 用在 ARM / 弱内存序上 | v1 无内存屏障。v2 写了全屏障，ARM 还没有单独验收 |
| 崩溃后自动回收读者槽、把段当持久存储 | v2 有心跳，能看写者是否还活着；崩溃读者的槽位不会自动让出 |
| 安全隔离 / 多租户 | 命名段无认证，同名可被抢先创建并伪造 magic |

一句话：它擅长**「现在这一帧」**，不擅长「所有帧」，更不擅长「一帧都不能少」。

## 安装

```bash
# PyPI 目前是 0.1.0，只有 v1
pip install shmring

# 仓库里的 0.2.0（含 v2）。Node 依赖 koffi；npm 包还没发布
pip install -e .
npm install
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

[`examples/electron-multi-camera/`](examples/electron-multi-camera/) 是第二档 showcase：一个 Python 进程开 5 个 `ShmRingWriterV2` 各写各的命名段（overwrite，写者不等读者），另有一段 160 导、512 Hz 的时序。Electron 用**一个** `setTimeout` 循环扫这些 v2 reader。左侧菜单在「视频」和「时序数据」之间切换；读取间隔在界面上改，1–5000 ms，默认 2 ms。`npm start` 给第 1 路加 `--real-camera`，没有设备就退回合成 PNG；`DEMO_REAL_CAMERA=0` 关掉。无头校验 `scripts/verify_multi.py` 不打开摄像头，也不启时序段。

它演示的是「同一进程内多个 writer 实例互不干扰」——帧号、`seq`、槽几何、线程锁全部实例隔离，一路卡住不影响其余四路。[`scripts/bench_multi.py`](scripts/bench_multi.py) 仍走 **v1** `ShmRingWriter`。2026-11-24 本机（Windows 10.0.26300，CPython 3.10.11，`shmring 0.2.0`，每帧 40960 B）：目标 30 fps 时实测 1 路 **21.2 fps**、5 路合计 **106.7 fps**，丢帧 0；不限速纯 publish 为 245924 fps（10073 MB/s），5 路 / 1 路 = 0.59×。限速没到 30 是 Windows `sleep` 粒度，不是环的上限。详见 [该目录 README](examples/electron-multi-camera/README.md)。

## API

### Python

| 对象 | 方法 / 属性 | 说明 |
| --- | --- | --- |
| `ShmRingWriter(name, capacity, slot_count, meta_capacity, replace=False)` | `publish(payload, meta=b"", stamp=None) -> frame_id` | 写一帧，返回帧号；`payload`/`meta` 支持 buffer protocol |
| | `info`, `payload_capacity`, `meta_capacity` | 布局信息 |
| | `close()`, `unlink()`, 上下文管理器 | `unlink()` 删除 OS 对象（Windows 为 no-op） |
| `ShmRingReader(name, retries=8)` | `read() -> Frame \| None` | 最新完整帧；`Frame(frame_id, stamp, payload, meta, seq)` |
| | `subscribe(callback, interval_ms=2) -> stop()` | 本进程轮询，序号变了就把最新帧的拷贝交给回调 |
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
| | `subscribe(callback, intervalMs=2) -> {stop}` | 本进程轮询，序号变了就把最新帧的拷贝交给回调 |
| | `readBatch(since?) -> {frames, dropped, newest}` | |
| | `info`, `lastFrameId`, `close()` / `detach()` | |
| 模块级 | `unlink(name)`, `normalizeName(name, forPosix)` | |

错误类型：两端都提供 `ProtocolError` / `SegmentNotFound` / `CapacityError` / `ShmRingError`（Node 另有 `SegmentExists`）。v2 另有 `ChecksumError`。

### v2

`ShmRingWriterV2` / `ShmRingReaderV2`（Node 同名）。默认 `overflow="overwrite"`，写者不等读者。读者默认 `role="observer"`、`join="tip"`（只看新帧）；`join="window"` 从环里还在的最老一帧读起。`read()` 不推进游标。跟不上时得到 `Gap`，处理完调用 `commit`，接受丢失则 `skip_to` / `skipTo`。`return` 下最多一个 `retainer`，过期心跳不再占环。校验默认 CRC32，`checksum=false` 关掉。

Python：`publish()` 返回 `PublishResult(accepted, frame_id)`；`FrameV2` 是 `(seq, stamp, payload, meta)`；`read_batch()` 返回 `BatchV2(frames, gap)`；`commit(seq)`、`skip_to(seq)`。`latest()` 只拷最新一帧，不推进游标。`subscribe(callback, interval_ms=2)` 在本进程里按这个间隔看 `write_pos`，序号变了就把最新帧的拷贝交给回调；返回对象的 `stop()` 结束循环，`close()` 也会停掉它。Node：`publish()` 返回 `{accepted, frameId}`；帧上 `seq` 与 `frameId` 相同；`readBatch()` 返回 `{frames, gap}`，`gap` 为 `{dropped, nextSeq}` 或 `null`；`commit(seq)`、`skipTo(seq)`；`latest()` 与 `subscribe(callback, intervalMs)` 同上，结束用 `stop()`。Node v2 接受 `replace: true`；Node v1 没有 `replace`。

订阅不出本进程。它只送当前最新一帧，中间被盖掉的序号不会逐个补上。`publish()` 里不会调用这个回调。

五路示例默认用 v2 overwrite。Electron 启动时加 `--real-camera`（`DEMO_REAL_CAMERA=0` 可关）：第 1 路是摄像头 JPEG，没有设备就退回合成 PNG。`scripts/verify_multi.py` 不打开摄像头，五路都断言 PNG。

## 平台支持状态

| 平台 | Python 后端 | Node 后端 | 验证情况 |
| --- | --- | --- | --- |
| Windows | `multiprocessing.shared_memory` → `CreateFileMapping` | `OpenFileMappingW` / `CreateFileMappingW` + `MapViewOfFile`（koffi） | **本机实测**：单测、双向对拍、五路示例 |
| Linux | 同上 → `shm_open` | `libc.so.6`：`shm_open` / `ftruncate` / `mmap`（koffi） | 工作流包含该平台。最近的 CI（含 `b115675`）失败，**本机未实测** |
| macOS | 同上 → `shm_open` | `libSystem.B.dylib`（含 31 字节段名限制、Darwin `O_CREAT` 常量） | 同上。v2 的 ARM 机器码还没有单独验收 |

平台差异由库内部消化：POSIX 段名自动加前导 `/`；Python 3.8–3.12 的 `resource_tracker` 误删问题在 attach 时 `unregister`（3.13+ 用 `track=False`）。

> 已知坑：Node 侧**不要**用 `koffi.view()` 把映射地址包成零拷贝视图——在 Electron 内置 Node 下会触发 `napi_is_detached_arraybuffer` FATAL ERROR。库内部统一用 `koffi.address()` + `memcpy` 复制到独立 Buffer。

## 限制

1. **单写者**：v1 和 v2 都是一段一个写进程。多个进程同时 `publish()` 会破坏 seqlock。
2. **内存序**：v1 依赖 x86/x64 的写顺序，ARM 未验证。v2 的写是全屏障 exchange，读是 `CAS(ptr, 0, 0)`。Windows 用自映射机器码；POSIX 优先 libatomic 的 `__atomic_exchange_*`，没有符号时用同一套机器码。ARM64 编码已写，尚未在 ARM 上单独验收。
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

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 `ubuntu-latest` / `macos-latest` / `windows-latest` 上跑上述步骤。到 `b115675` 为止这些 run 都是失败，不能把「矩阵里有这个平台」当成该平台已通过。OIDC 发布通道见 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)，它只在 `v*` tag 上发 npm。

## 发布

Python 包发到 PyPI，Node 包发到 npm，版本号保持一致。

### 首版 0.1.0（一次性，交互式 2FA）

PyPI 已发布。npm 首版必须由维护者本人在**交互式终端**完成（账号需已启用 2FA）：

```bash
npm login          # 浏览器授权
npm publish        # 按提示输入 authenticator 的 6 位 OTP
# 非交互场景可显式传码：npm publish --otp=123456（30 秒内有效）
```

两条自动化路径在首发都被堵死：

- **Bypass-2FA Granular Access Token 已不能直接发布**。按 [GitHub Changelog 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)，这类 token 先是被禁止账号/包治理操作，随后连 direct publish 一并收回（CLI 会打印 `npm tokens that bypass 2FA are being restricted for account changes and direct publishing`），2027-01 起只保留「读私有包 + stage」，须由维护者用 2FA 批准。实测 `npm publish` 返回 403 `Two-factor authentication or granular access token with bypass 2fa enabled is required`。
- **Trusted Publishing 只在 CI 云托管 runner 里可用**，且配置入口挂在包自己的 Settings 页；包还不存在时无法配置，OIDC 首发也尚未支持（npm/cli#8544）。

所以首版走官方默认的「交互式发布 + 2FA」是唯一可行解，而不是退而求其次。

### 后续版本（Trusted Publishing / OIDC）

[`publish.yml`](.github/workflows/publish.yml) 在 `v*` tag 推送时触发，靠 GitHub Actions 的 OIDC 短期凭证发布：**仓库不存任何 token**，provenance 证明自动生成。首次启用前在 npmjs.com 配置一次：

| 字段 | 值 |
| --- | --- |
| 入口 | `npmjs.com/package/shmring` → Settings → Trusted publishing |
| Organization or user | `Huochengyan` |
| Repository | `shmring` |
| Workflow filename | `publish.yml`（只填文件名，须带 `.yml`） |
| Environment name | 留空 |
| Allowed actions | 勾 **`npm publish`**（2026-09-03 后新建的配置默认只给 `npm stage publish`，不勾会 401/404） |

配置创建后须在 **48 小时内完成一次成功发布**才算绑定生效，过期需删掉重建。之后发版：

```bash
npm version patch                     # 0.1.0 → 0.1.1，自动 commit + tag v0.1.1
git push origin master --follow-tags
```

绑定完成后可把包的 Publishing access 设为 **"Require two-factor authentication and disallow tokens"**，彻底关闭传统 token 通道（该设置只影响 token，不影响 OIDC）。PyPI 侧同理可用 Trusted Publisher 替代 API token。

> 首版 0.1.0 **不要打 `v*` tag**：那时 trusted publisher 尚未绑定，会触发失败的发布 job。

## 路线图

- [x] **v2**：写者不等读者；环满时覆盖，或把该帧立刻交还调用方。Python 与 Node 已实现，见 [V2_DESIGN.md](V2_DESIGN.md)。v1 语义保持「最新优先、可丢」不变
- [ ] 发布 `shmring` 0.2.0 到 PyPI。仓库版本已是 0.2.0；PyPI 上仍是 0.1.0（2026-11-22）
- [ ] 发布到 npm 0.1.0（首版本机 `npm login`；0.1.1 起走 Trusted Publishing，见「发布」）
- [ ] Node **v1** 的 `replace`。Node v2 已支持
- [ ] ARM / 弱内存序平台的屏障验收（v2 机器码已写，尚未在 ARM 上跑过）
- [x] v2 的 CRC32，默认开启。v1 槽头仍写 0、读者不校验
- [ ] Rust / C 参考实现，进一步证明协议语言无关

## 协议与许可

完整线上格式、状态机、校验规则与兼容性承诺见 [PROTOCOL.md](PROTOCOL.md)。修改协议必须提升 `VERSION`。
v2 见 [V2_DESIGN.md](V2_DESIGN.md)。写者不等读者；环满时覆盖或把该帧交还调用方。默认导出仍是 v1。

MIT © 2026 meta_codes
