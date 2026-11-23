# shmring v1 → v2 演进设计

> **状态：设计稿，未实现。** 本文把 v1 的实际行为和 v2「无损队列」所需的**全部改动**整理成一份清单。
> 当前仓库只实现了 v1（`VERSION = 1`，PyPI `shmring 0.1.0`），v2 没有任何代码。
> 修改线上格式必须提升 `VERSION`，见 [PROTOCOL.md](PROTOCOL.md) 第 8 节「兼容性承诺」。
>
> 权威的 v1 格式定义始终是 `PROTOCOL.md`；本文是**差异说明与设计方案**，不覆盖它。

---

## 0. 一句话结论

v1 是「最近 N 帧的**窗口**」，写者无条件覆盖最老的槽；v2 要变成「有背压的**无损队列**」。
关键不是「给每帧加 id」——id 库里早就有（`frame_id`），只能让你**发现**丢了，不能让你**不丢**。
不丢帧靠的是：**读者把消费进度写回共享内存 + 写者发现槽满时停下来（背压）或落盘（spill）**。

还有一个绕不开的硬约束：

> **有限容量 + 写者永不阻塞 + 一个样本不丢，三者不可兼得。**
> 要无损，槽满时必须在「阻塞等待」和「溢出写盘」里二选一。v1 选了「永不阻塞」，代价就是必然丢旧帧。

---

## 1. 为什么需要 v2

v1 为视频设计：每帧自包含、最新优先、允许静默丢历史。实测（Windows，640×360 MJPEG）30 fps、帧龄 avg 1ms、跳帧 0；5 路并发合计 147 fps、丢帧 0。

但两类需求 v1 的语义从根上不对：

- **连续采样流**（EEG/EMG/生理信号、音频 PCM、高频遥测）：丢一个 block 会让之后的样本序号、`sample_start`、trigger/marker 对齐、ERP 叠加整体错位，而波形看着正常、不会报错。默认 4 槽 @1000 Hz 只有 **4ms** 容错窗口。
- **需要完整历史 / 可复现 / 可审计**的场景（录制、训练集、故障回放）：`dropped` 只是事后统计，补不回数据。

另外 v1 的生产就绪欠账（弱内存序屏障、写者存活信号、close 后读写、真实段大小校验、并发压测证据）也需要在演进中一并处理。详见第 3、6 节。

---

## 2. v1 基线（0.1.0，当前代码）

| 项 | 实际行为 | 代码 / 文档位置 |
| --- | --- | --- |
| 全局头 | 64 B，`<IHHHHIqqqiiii8x`：`magic/version/header_size/endian/flags/capacity/seq/frame_id/stamp/slot_count/slot_size/meta_capacity/payload_offset/8B reserved` | `PROTOCOL.md:34-63`、`shmring/_protocol.py:19` |
| 槽头 | 32 B，`<qqiiIi`：`frame_id/stamp/length/meta_len/checksum/flags`；`checksum` v1 写 0、读者不校验 | `PROTOCOL.md:83-92` |
| 槽定位 | `base = 64 + (frame_id % slot_count) * slot_size`，**按帧号取模无条件覆盖，从不读取者进度** | `shmring/writer.py:134`、`PROTOCOL.md:72` |
| 发布 | 三步：写奇数 `seq` 宣告写入中 → 载荷 → meta → **最后**写槽头 → 写偶数 `seq` + 新 `frame_id` 一次性提交 | `shmring/writer.py:137-148`、`PROTOCOL.md:103-116` |
| 单帧读 | 双检 seqlock（`seq1 == seq2` 且偶数且 `frame_id` 未变），复制出独立 Buffer | `PROTOCOL.md:120-127` |
| 批量读 | `first = max(cursor+1, newest - slot_count + 1)`；批量期间 seqlock 变化则**整批丢弃且 `dropped = 0`** | `shmring/reader.py:100,107-109` |
| 丢帧报告 | `dropped = max(0, newest - cursor - len(frames))`，纯事后统计 | `shmring/reader.py:112` |
| 默认值 | `capacity = 8 MiB`、`slot_count = 4`、`meta_capacity = 256` → 约 2 MiB/帧 | `shmring/_protocol.py:14-16` |
| 拓扑 | 单写者 + N 读者；读者各有**进程内**游标 `self._last` | `PROTOCOL.md:11`、`shmring/reader.py` |
| 内存序 | 无屏障，仅依赖 x86/x64 的 8 字节对齐原子性；ARM 弱序不保证 | `PROTOCOL.md:16` |
| 时钟 | `stamp` 为 Unix 毫秒，**仅诊断，不参与正确性判断**（允许回拨） | `PROTOCOL.md:17` |
| 读端拷贝 | 必须复制出独立 Buffer；**不是零拷贝** | `PROTOCOL.md:136` |

**语义原文**（`PROTOCOL.md:13`、`:150`）：「最近 N 帧的历史窗口，不是队列」「读者落后超过 `slot_count` 帧必然丢帧（设计取舍：宁丢旧帧，不堆积延迟）」。

> 所以「5 路 benchmark 丢帧 0」是 **30 fps 限速 + 2 ms 扫描 + 4 槽**下的稳态观测，证明视频节奏够用，**不是不丢帧的保证**。

### v1 已知限制（`PROTOCOL.md:145-151`）

1. 单写者，多写者需外部仲裁；
2. 弱内存序 CPU 未验证；
3. 段 ≤ 4 GiB（`capacity` 为 u32）；
4. 落后超过 `slot_count` 帧必然丢帧；
5. `stamp` 只用于诊断。

---

## 3. v1 收尾（0.2.0，不动协议）

这一档修的是**长稳与安全性**，**不**把语义改成队列。它们与 v2 独立，可以先行发布。

### P0 — 阻塞上线

| # | 问题 | 改动 |
| --- | --- | --- |
| 1 | 跨进程无 release/acquire 屏障，ARM 上可能双检通过却拿到上一帧 | v1 明确限定 x86_64 小端并在 attach 时拒绝其他平台；屏障留到 v2 |
| 2 | Node 把头里的 `capacity` 当真实映射大小，头损坏可越界 `memcpy` 崩主进程 | attach 时取 OS 真实段大小（`VirtualQuery` / `fstat`）比对，Python `_read_slot` 包越界异常 |
| 3 | `close()` 后仍可读写（use-after-unmap） | 平台层 + ring 层加状态位，读写前检查并抛 typed error |
| 4 | 启动竞态甩给调用方（showcase 自己写了 15 s 重试） | 库内 `attach_timeout` + 退避，区分「段不存在」与「头未就绪」 |
| 5 | 写者崩溃无存活信号，读者一直读到同一帧 | reserved 8 B 放 `writer_epoch` + `heartbeat`（可不动 `VERSION`，走 flags 位） |
| 6 | 缺并发撕裂压测 / soak / 故障注入 / 多 reader 并发，CI 矩阵单薄 | 补测试 + 三平台多版本 CI 门禁 |

### P1 — 上线前应该有

- 批量作废会饥饿且静默：逐槽校验 + 按已确认槽推进，或返回明确 `retry`（修 `reader.py:107-109`）；
- 单写者无 fencing：头里放 `writer_pid + epoch`，第二个写者拒绝接管；两端 `replace` 行为对齐；
- 默认开 CRC32（槽头已预留 `checksum`）；
- Python reader 改只读映射（POSIX 当前 `O_RDWR` 能写坏段）；
- 补 `wait(timeout)` / 事件通知，或在文档明确轮询责任与 CPU 成本；
- 段名命名空间（Windows 会话级、POSIX `/dev/shm` 64 MB、macOS 31 B）文档 + 随机名生成器 + ACL 建议。

---

## 4. v2 目标与不变量

**目标**：同机、跨语言、**无损**的帧/块传输；保留 v1 的低延迟与「一路一段」隔离能力。

不变量：

1. 任何已 `publish()` 且**未被所有 reader 确认**的帧，不得被覆盖；
2. 槽满时写者必须阻塞、落盘或显式报错，不允许静默覆盖；
3. 1 写者 + N 读者，读者进度是**共享状态**，不是进程内变量；
4. 每次读到的帧序号严格连续，缺口必须显式报错而非静默；
5. 写者崩溃 / 重启可检测，可恢复或明确失败；
6. acquire/release 原子，x86 与 ARM 都正确；
7. 交付语义写进文档：建议「至少一次 + 幂等去重」，不假装能做到恰好一次。

---

## 5. 机制差异

```
v1  覆盖式窗口（写者单向）
    写者 ──写槽(fid % N)──> [s0 s1 s2 s3] ──读──> 读者
    写者从不读取者进度；读者落后 > N 帧 ⇒ 旧帧已被覆盖 ⇒ dropped++

v2  双游标无损队列（读者回写）
    写者 --检查 W-min(R) < N--> [s0 s1 s2 s3] --读--> 读者
              ▲                                    │
              └────── release-store read_pos ──────┘
    槽满 ⇒ 背压阻塞 / spill 落盘 / 抛错；不覆盖任何未确认帧
```

`W = write_pos`（下一个可写序号），`R_i = read_pos[i]`（第 i 个读者下一个待读序号）。
可覆盖条件：`W - min(R_i) < slot_count`。

---

## 6. v1 → v2 逐项改动清单（本文核心）

| # | 项 | v1 现状 | v2 改动 |
| --- | --- | --- | --- |
| 1 | 覆盖策略 | `writer.py:134` `fid % slot_count` 无条件覆盖 | 写前校验 `W - min(R) < slot_count`；不满足则走 `overflow_policy` |
| 2 | 读者进度 | 仅进程内 `self._last`（`reader.py:111`） | 共享 `read_pos[MAX_READERS]`；读完 `release-store` 回写 |
| 3 | 全局头 | 64 B，`seq/frame_id/stamp` + 几何 | 扩到 ≥ 128 B（建议 1024 B 以便缓存行对齐），新增 `write_pos/read_pos[]/writer_pid/writer_epoch/heartbeat/overflow_policy/max_readers/checksum_algo` |
| 4 | 发布提交 | 奇偶 `seq` seqlock（`writer.py:138-148`） | 改为 `release-store(write_pos, W+1)`；槽内保留 `slot_seq` 供读者校验，seqlock 可退化为单槽防撕裂 |
| 5 | 内存序 | 无屏障，x86 碰巧成立（`PROTOCOL.md:16`） | `acquire_load` / `release_store`；Win 用 `InterlockedCompareExchange64`，POSIX 用 `libatomic` / `__atomic`（ctypes 调用） |
| 6 | 槽满 | 静默覆盖，`dropped` 事后统计 | `overflow_policy = block / spill / error`；block 时条件等待，spill 时写盘并把槽标记为「已溢出，读端从盘取」 |
| 7 | 批量作废 | `reader.py:107-109` 整批丢弃且 `dropped=0` | 逐槽独立校验，按已确认槽推进游标；返回明确 `retry`，禁止静默空批 |
| 8 | 完整性 | `checksum` 写 0、读者不校验（`PROTOCOL.md:91`） | 默认 CRC32，失败抛 `ChecksumError` 并触发重同步 |
| 9 | 帧标识 | 全局头 `frame_id` + 槽头 `frame_id` | payload 内自带 `block_seq + sample_start + n_samples + rate + CRC32`；读端三重校验 `block_seq == expected`、`sample_start == expected_sample`、`crc_ok` |
| 10 | 存活检测 | 无 | `writer_pid` + `writer_epoch` + `heartbeat_ms`；读者按心跳判离线，epoch 变化触发重同步 |
| 11 | 单写者 fencing | 无（P1） | 头里 `writer_pid/epoch`，第二个写者拒绝接管；`replace` 需显式 `force` |
| 12 | 交付语义 | 无定义 | 明确「至少一次 + 幂等」：先处理/落盘 + 按序号去重 + 再提交 `read_pos` |
| 13 | 多读者 | N 个独立 cursor，覆盖是全局的 | `read_pos[8]`，写者取 `min()`；慢消费者会拖住全部 → 建议单 reader（存盘进程）再扇出给显示/算法 |
| 14 | 平台原子 | Python 无原生原子 | `ctypes` 调 `Interlocked*` / `libatomic`；这是 v2 主要工程成本，Node 侧可用 `Atomics` + `SharedArrayBuffer` 或同样走 FFI |
| 15 | API | `publish/read/read_batch/close/unlink` | 新增 `wait(timeout)`、`stats()`、`attach_timeout`；`publish`/`read` 签名尽量不变，新增 `ShmRingWriterV2` / `protocol=2` 入口 |
| 16 | 错误类型 | `ProtocolError/CapacityError` 等 | 新增 `BackpressureError/ChecksumError/WriterGoneError/SequenceGapError` |
| 17 | 协议版本 | `VERSION = 1`，`header_size = 64` | `VERSION = 2`，`header_size` 变更，`magic` 不变；遇到不支持的 version 明确报错、拒绝混连 |
| 18 | 测试 | 单进程串行读写 + 手工篡改头 | 并发撕裂压测、soak、写者崩溃恢复、损坏输入 OOB、多 reader、慢消费者背压、跨语言双向对拍、三平台 CI |

> **id 的正确角色**：`block_seq` / `sample_start` 只用于**校验连续性、去重、重同步锚点**。
> 数据一旦被覆盖，内存里就没有了；除非落盘日志里还有，否则 id 补不回任何样本。
> 只加 id 的净效果是「能更早更准地发现丢」，**一点也不减少丢**。

---

## 7. v2 全局头草案（未定稿）

`magic` 与「前 16 字节布局前缀」保持不变，便于读者先识别版本再选解析器。

| 偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | u32 | `magic` | `0x524D4853`，**不变** |
| 4 | u16 | `version` | **`2`** |
| 6 | u16 | `header_size` | 建议 `1024`（给 `read_pos[]` 留缓存行空间） |
| 8 | u16 | `endian` | `0x0102`，不变 |
| 10 | u16 | `flags` | bit0 checksum / bit1 spill / bit2 has_heartbeat |
| 12 | u32 | `capacity` | 段总字节数 |
| 16 | i64 | `write_pos` | 下一个可写序号（= 已发布帧数） |
| 24 | i64 | `writer_pid` | 创建者 PID |
| 32 | i64 | `writer_epoch` | 每次 create 单调递增 / 随机，用于识别重启 |
| 40 | i64 | `heartbeat_ms` | 写者最后活跃 Unix ms |
| 48 | u32 | `slot_count` | 槽数 |
| 52 | u32 | `slot_size` | 每槽字节数 |
| 56 | u32 | `meta_capacity` | meta 区字节数 |
| 60 | u32 | `payload_offset` | `32 + meta_capacity` |
| 64 | u32 | `max_readers` | 建议 `8`（上限，非动态） |
| 68 | u32 | `overflow_policy` | `0=block, 1=spill, 2=error` |
| 72 | u32 | `checksum_algo` | `0=none, 1=crc32` |
| 76 | u32 | `reserved0` | 写 0 |
| 128… | i64 × 8 | `read_pos[0..7]` | **每个 reader 独占一个 64 B 缓存行**，避免伪共享；未使用的槽写 `-1` |

槽布局沿用「32 B 槽头 + meta + payload」，但槽头 `frame_id` 语义改为 `slot_seq`（== 写入时的 `W`），并启用 `checksum`。
`payload` / `meta` 仍是不透明字节，库不解析编码。

---

## 8. 写 / 读伪代码

```python
def publish(self, payload, meta=b"") -> int:
    W = self.W                                   # 写者本地序号
    while True:
        rp = min(acquire_load(self.hdr.read_pos[i])
                 for i in active_readers(self.hdr))   # 最慢的读者
        if W - rp < self.slot_count:
            break                                    # 有空位
        self.backpressure()                          # block / spill / raise

    base = HEADER_SIZE + (W % self.slot_count) * self.slot_size
    write_payload(base, payload)                     # 1) 先载荷
    write_meta(base, meta)                           # 2) 再 meta
    crc = crc32(payload) if self.checksum else 0
    write_slot_header(base, slot_seq=W, crc=crc, length=len(payload))  # 3) 槽头最后
    release_store(self.hdr.write_pos, W + 1)        # 4) 发布（release 保证前面写入可见）
    self.W = W + 1
    return W


def read(self):
    W = acquire_load(self.hdr.write_pos)
    R = self.R
    if R >= W:
        return None                                  # 真·没有新数据
    f = read_slot(R)
    assert f.slot_seq == R and crc_ok(f), SequenceGapError
    # 注意顺序：先处理/落盘（幂等），再提交游标
    self.handle(f)                                   # 应用侧按序号去重
    release_store(self.hdr.read_pos[self.id], R + 1)
    self.R = R + 1
    return f
```

三个必须一起处理的坑：

1. **恰好一次不存在**：先回写游标再处理 → 崩溃丢；处理完再回写 → 崩溃重复。EEG 落盘用「先写盘 + 按序号幂等去重 + 再提交游标」，对外承诺「至少一次」。
2. **Python 没有原生原子**：`multiprocessing.shared_memory` 只是字节；必须 `ctypes` 调 `InterlockedCompareExchange64`(Win) / `__atomic`(GCC)，或跨进程命名互斥体。这同时把 v1 的 ARM 屏障欠账修掉。
3. **多读者会互相拖累**：写者取 `min(read_pos)`，慢的存盘 reader 会挡住全部。建议单 reader 扇出，慢消费者走磁盘而不是共享内存。

---

## 9. 兼容性与迁移

- `magic` 与 `header_size` 的校验规则不变；`version` 只在**不兼容**变更时递增 → v2 用 `VERSION = 2`。
- 读者遇到不支持的 `version` 必须**明确报错**，不得按旧布局静默解析（`PROTOCOL.md:142`）。
- **禁止同名段混连**：v1 写者 + v2 读者（或反之）必须被 magic/version/header_size 校验挡住。建议段名带版本后缀，如 `xxx_v2`。
- **双协议并存**：不要改 `ShmRingWriter` 的既有语义。新增 `ShmRingWriterV2` / `ShmRingReaderV2`（或 `protocol=2` 参数），v1 类保持「最新优先、可丢」不变。两个协议可以共存在一个包里，但不能共用一个段。
- **API 兼容**：`publish()` / `read()` / `read_batch()` 签名尽量不动；`wait()`、`stats()`、`attach_timeout` 是新增能力。
- **发版**：v1 收尾走 `0.2.0`；v2 协议升级建议走 `0.3.0` 或 `2.0.0`，PyPI / npm 双包同步。

---

## 10. 落地顺序与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| 0 | 把当前提交推 GitHub，确认三平台 CI 全绿（POSIX 后端首次真跑） | Actions 三平台 + benchmark 冒烟 + 5 段跨语言校验全绿 |
| 1 | **0.2.0**：第 3 节 P0/P1 实现修复，不动协议 | close 后读写抛错、真实段大小校验、库内 attach 重试、CRC32、并发压测 0 撕裂 |
| 2 | **v2 原型**：新类 + 双游标 + 背压 + CRC + 原子，先只支持 x86_64 单 reader | 并发写读压测 **0 丢**；写者崩溃后 epoch 变化可检测；慢 reader 背压生效；跨语言双向对拍 |
| 3 | **v2 完整**：多 reader、spill、ARM 屏障、soak、故障注入 | ARM CI 绿、24 h soak、崩溃恢复、损坏输入不崩、文档与 `PROTOCOL.md` v2 章节同步 |

---

## 11. 什么时候不该用 v2

- **实时显示 / 频谱 / 在线推理**：v1 + 20–100 ms block 聚合 + 序号/CRC 校验就够，v2 的背压反而会把采集端拖慢、把延迟堆积起来。
- **科研级 EEG 记录**：直接用 **LSL (Lab Streaming Layer)**——自带采样时钟同步、无损传输、跨语言 API 与录制工具。v2 只解决「同机无损传输」，不提供设备时钟同步、EDF+/HDF5 落盘或实验标记系统。
- **跨机器 / 持久化 / 多写者**：都不在本库范围内，用 ZeroMQ / Kafka / 消息队列 + 数据库。

一句话：v1 擅长「现在这一帧」，v2 擅长「一帧都不少」，两者都**不**擅长「跨机器可靠投递」。

---

## 12. 未决问题

1. `read_pos[]` 固定 8 个槽够不够？reader 崩溃后其槽位如何回收（epoch + 心跳超时自动释放）？
2. `overflow_policy=spill` 的落盘格式与回放 API 由库提供，还是交给应用？
3. `writer_epoch` 如何跨进程持久化（段内自增即可，但进程重启后需保证不回退）？
4. Node 侧原子用 `Atomics` + `SharedArrayBuffer` 还是继续走 koffi FFI？两者在 Electron 内置 Node 下的可用性需实测。
5. v2 是否仍承诺「读端必须复制出独立 Buffer」？无损队列 + 大 block 下这份拷贝是否会成为新瓶颈，需要基准数据再定。

---

相关文档：[README.md](README.md)（定位、适用场景与不适用）、[PROTOCOL.md](PROTOCOL.md)（v1 权威格式）、[CHANGELOG.md](CHANGELOG.md)（版本记录）。
