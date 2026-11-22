# shmring wire protocol v1

本文件定义 `shmring` 的**线上内存格式**。它是语言无关的：任何能映射 OS 命名共享内存、并按小端读写固定偏移的实现，都可以与 Python / Node 实现互通。

实现与本文件冲突时，**以本文件为准**。修改本协议必须提升 `VERSION`，并遵守文末的兼容性承诺。

## 1. 设计目标与约束

| 项 | 约定 |
| --- | --- |
| 拓扑 | **单写者、多读者**。多个进程同时 `publish()` 会破坏 seqlock，不在 v1 支持范围内 |
| 同步 | 无锁。显式 seqlock + 环形覆盖，不使用互斥量、条件变量、系统调用或进程间握手 |
| 语义 | **最近 N 帧的历史窗口**，不是队列。读者落后超过 `slot_count` 帧时旧帧已被覆盖，实现必须跳过并报告 `dropped` |
| 字节序 | **固定小端**。不提供大端适配；`endian` 字段用于检测误连 |
| 容量 | 段大小 `capacity` 为 `uint32`，上限 4 GiB − 1；实际建议 ≤ 2 GiB |
| 内存序 | 依赖 8 字节对齐读写的原子性与写顺序。**x86 / x64 保证**；ARM 等弱内存序平台需实现方自行加屏障，v1 不保证 |
| 时钟 | `stamp` 为 Unix 毫秒，仅用于帧龄诊断，**不参与正确性判断**（允许时钟回拨） |

## 2. 段命名

| 平台 | OS 对象 | 名字规则 |
| --- | --- | --- |
| Windows | 会话级 file mapping（内核 namespace） | 原名直接使用，例如 `shmring_demo`。不得含 `\`；建议仅用 `[A-Za-z0-9_-]` |
| POSIX (Linux / macOS) | `shm_open` 对象 | 打开时**必须加前导 `/`**：`shmring_demo` → `"/shmring_demo"`。macOS 对名字长度有严格限制（约 31 字节），实现应在超长时报错而非截断 |

库必须提供 `normalizeName()` 统一处理该差异；调用方永远使用**不带斜杠**的逻辑名。

### 生命周期

- 由 `create()` 的一方负责最终 `unlink()`；`close()` / `detach()` 只解除本进程映射。
- POSIX 上 Python 3.8–3.12 的 `resource_tracker` 会在任一 attach 过的 Python 进程退出时误删段，实现必须 `unregister`（3.13+ 改用 `track=False`）。
- 进程崩溃可能残留段。实现应提供 `unlink(name)` 供清理，并允许 attach 时通过 magic 校验识别陈旧段。

## 3. 全局头（64 字节，段偏移 0）

`struct` 格式串：`<IHHHHIqqqiiii8x`（紧密打包，共 64 字节）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- | --- |
| 0 | 4 | u32 | `magic` | 固定 `0x524D4853`，即字节 `SHMR` 的小端读法 |
| 4 | 2 | u16 | `version` | 协议版本，v1 = `1` |
| 6 | 2 | u16 | `header_size` | 固定 `64` |
| 8 | 2 | u16 | `endian` | 固定 `0x0102`；读到其他值说明字节序/布局不符 |
| 10 | 2 | u16 | `flags` | 保留，写 `0` |
| 12 | 4 | u32 | `capacity` | 段总字节数 |
| 16 | 8 | i64 | `seq` | seqlock 序号：奇数 = 写者写入中，偶数 = 稳定 |
| 24 | 8 | i64 | `frame_id` | 最近完成帧号，`-1` 表示尚无帧 |
| 32 | 8 | i64 | `stamp` | 最近完成帧的发布时间（Unix ms） |
| 40 | 4 | i32 | `slot_count` | 环形槽数量，≥ 1 |
| 44 | 4 | i32 | `slot_size` | 每槽字节数（含槽头与 meta 区） |
| 48 | 4 | i32 | `meta_capacity` | 每槽 meta 区字节数（可为 0） |
| 52 | 4 | i32 | `payload_offset` | payload 相对槽起始的偏移，= `32 + meta_capacity` |
| 56 | 8 | — | reserved | 写 0 |

`capacity`、`slot_count`、`slot_size`、`meta_capacity`、`payload_offset` 在 `create()` 后**不可变**。读者必须校验：

```
magic == 0x524D4853 and version == 1 and endian == 0x0102 and header_size == 64
capacity >= 64 + slot_count * (slot_size)
slot_count >= 1
slot_size > 32 + meta_capacity
payload_offset == 32 + meta_capacity
```

任一不满足即拒绝 attach（不要猜、不要兼容旧版）。

## 4. 槽布局

槽 `i` 的起始偏移：

```
base(i) = 64 + (frame_id % slot_count) * slot_size
```

单个槽内部：

| 相对槽起始 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 32 | 槽头 |
| 32 | `meta_capacity` | meta 区（可选元数据，原样字节） |
| `payload_offset` | `length` | payload（帧主体字节） |

槽头格式串：`<qqiiIi`（32 字节）

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- | --- |
| 0 | 8 | i64 | `frame_id` | 该槽存放的帧号；`-1` 表示空槽 |
| 8 | 8 | i64 | `stamp` | 发布时间（Unix ms） |
| 16 | 4 | i32 | `length` | payload 字节数 |
| 20 | 4 | i32 | `meta_len` | meta 有效字节数 |
| 24 | 4 | u32 | `checksum` | 保留，v1 写 `0`，读者不校验 |
| 28 | 4 | i32 | `flags` | 保留，写 `0` |

`payload` 与 `meta` 都是**不透明字节**，库不做任何解析、不假定编码、不追加终止符。

## 5. 初始化（`create`）

1. 创建/打开命名段，大小 `capacity`。
2. 写全局头：`seq=0, frame_id=-1, stamp=0` + 第 3 节的布局字段。
3. 对每个槽写槽头：`frame_id=-1, stamp=0, length=0, meta_len=0, checksum=0, flags=0`。
4. 槽的 payload 区可以不清零。

## 6. 写入（`publish`）

设写者本地维护 `seq`（偶数）与 `frame_id`。

1. **开始写**：`seq += 1`（奇数）写回全局头，`frame_id` 保持旧值。读者见到奇数必须跳过本拍。
2. **写槽**（顺序不可颠倒）：
   1. 写 payload 到 `base + payload_offset`
   2. 写 meta 到 `base + 32`
   3. **最后**写槽头（`frame_id` = 新帧号、`length`、`meta_len`、`stamp`）
3. **提交**：`seq += 1`（偶数），一次性写回 `seq`、`frame_id`（新值）、`stamp`。

> 为什么槽头必须最后写：若先写槽头，读者可能看到有效 `frame_id` 却读到上一帧的旧 payload。先载荷后槽头保证「看到有效槽头 ⇒ 载荷已就位」。

写者必须串行调用 `publish()`（内部用线程锁保护）。

## 7. 读取

### 单帧 `read()`

1. 读全局头，执行第 3 节校验；`seq` 为奇数 → 重试或返回空。
2. 记下 `seq1`、`frame_id`。`frame_id < 0` → 尚无帧。
3. `base = 64 + (frame_id % slot_count) * slot_size`，读槽头。
4. 校验 `slot.frame_id == frame_id`，且 `0 <= length <= slot_size - payload_offset`、`0 <= meta_len <= meta_capacity`。
5. 复制出 payload 与 meta 到独立缓冲区。
6. 重读全局头得 `seq2`；必须 `seq2 == seq1` 且 `seq2` 为偶数且 `frame_id` 未变，否则整帧作废重试。

### 批量 `read_batch(since)`

1. 同上取 `seq1` 与 `newest = frame_id`。
2. `first = max(since + 1, newest - slot_count + 1)`，逐个读 `first..newest` 的槽；每个槽独立校验 `slot.frame_id == id`。
3. 全部读完后重读全局头，`seq` 与 `frame_id` 均未变才认为**整批**有效；否则整批丢弃。
4. 返回帧列表，并报告 `dropped = newest - since - len(frames)`（读者落后量）。

> 映射内存随时会被写者覆盖，因此**必须**把 payload/meta 复制到独立缓冲区后再交给调用方。禁止把映射地址直接暴露为零拷贝视图（`koffi.view()` 在 Electron 内置 Node 下还会触发 N-API 崩溃）。

## 8. 兼容性承诺

- `magic` 与 `header_size` 永不改变；`version` 只在**不兼容**变更时递增。
- `version` 相同 ⇒ 布局字段语义不变；新增字段只能放进 reserved 区并伴随 minor 版本说明。
- 读者遇到 `version` 不支持时必须明确报错，不得静默按旧布局解析。
- 本仓库的 Python 与 Node 实现必须互相对拍通过，才允许发版。

## 9. 已知限制

1. 单写者；多写者需要外部仲裁。
2. 弱内存序 CPU 未验证。
3. 段大小 ≤ 4 GiB；`capacity` 用 `uint32` 存储。
4. 读者落后超过 `slot_count` 帧必然丢帧（设计取舍：宁丢旧帧，不堆积延迟）。
5. `stamp` 只用于诊断，时钟回拨不影响正确性。
