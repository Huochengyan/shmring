# shmring v2 设计

> **状态：已实现（Python `shmring.v2` 与 Node `lib/ring-v2.js`）。** 包的默认 `PROTOCOL_VERSION` 仍是 v1。
> v2 用 `ShmRingWriterV2` / `ShmRingReaderV2`，不能和 v1 混接同一个段。
> 权威的 v1 格式仍是 [PROTOCOL.md](PROTOCOL.md)。

## 1. 规则

写者不等读者。`publish()` 里不睡眠、不等条件变量、不等磁盘、不读旁路读者的进度。

环里没有空位时，写者立刻做下面两件事里的一件，然后返回：

| 策略 | 行为 |
| --- | --- |
| `overwrite`（默认） | 新帧写入下一个槽，覆盖槽里的旧帧。返回新帧序号 |
| `return` | 这个槽仍被**活着的占槽读者**占着时，不改环，把这一帧交还调用方（`accepted=false`）。调用方自己丢弃或另存。库不写盘 |

慢的旁路读者只丢掉自己没跟上的帧。其他读者继续读自己还够得着的帧，写者继续发布。

有限容量、写者永不阻塞、每一帧都留在环里，三者不能同时成立。v2 把取舍交给策略：`overwrite` 丢掉没跟上的那一路；`return` 拒绝收下新帧，由调用方处理。两种策略都不在 `publish()` 里等人。

## 2. 读者两种角色

| 角色 | 谁用 | 对写者的影响 |
| --- | --- | --- |
| `observer`（默认，旁路读者） | 预览、推理、仪表 | 没有。落后超过 `slot_count` 时，这一路得到 `Gap`，写者无感 |
| `retainer`（占槽读者） | 明确要求「我没提交的帧先别覆盖」的那一路 | **只在 `return` 下生效**。它没提交、且心跳未过期时，写者不再覆盖它还占着的槽，把新帧交还调用方 |

默认没有占槽读者。此时 `return` 和 `overwrite` 一样，每次 `publish()` 都把新帧写入环。

占槽读者是显式登记的。显示线程不要登记成占槽读者。一个段最多一个占槽读者；多出来的 `attach` 直接失败。

`return` 且占槽读者没跟上时，交还的那一帧**不在环里**，旁路读者也看不到。写者线程不会停在 `publish()` 里。调用方丢掉它、或自己另存，都发生在 `publish()` 返回之后。

占槽读者心跳超过 `stale_ms` 就视为不在了：它不再把环占满，之后的 `publish()` 可以覆盖它没提交的帧。死读者不能把环钉死。它若还醒着，下一次 `read()` 得到 `Gap`。处理一帧的时间可能超过 `stale_ms` 时，处理循环里要调用 `heartbeat()`，或把 `stale_ms` 设大。

## 3. 拓扑

```
overwrite（默认）
    写者 ──始终写入 W % N──> [s0 s1 s2 s3] ──各读各的──> 旁路读者
    写者不看 read_pos
    某路落后超过 N 帧 ⇒ 只有这一路得到 Gap

return，且存在活着的占槽读者
    写者 ── W - read_pos < N ? ──> 是：写入并发布
                                 └─ 否：立刻 accepted=false，环的字节不变
    旁路读者的 read_pos 不参与这次判断
```

`W = write_pos`，下一个要写的序号，也等于已发布帧数。`read_pos[i]` 是该读者下一个待读序号。可覆盖（或可写入）的条件只在 `return` 里检查，且只看活着的占槽读者：`W - read_pos < slot_count`。没有活着的占槽读者时，这个条件视为成立。

## 4. 全局头（1024 字节）

前 16 字节和 v1 相同，用来认出版本然后拒绝混接。`magic` 仍是 `0x524D4853`。

`write_pos` 单独占一条缓存行。写者心跳另占一条。每个读者槽独占 64 字节。8 个读者从偏移 192 排到 704，其余填 0 到 1024。

### 4.1 缓存行 0（偏移 0，创建后不变）

| 偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | u32 | `magic` | `0x524D4853` |
| 4 | u16 | `version` | `2` |
| 6 | u16 | `header_size` | `1024` |
| 8 | u16 | `endian` | `0x0102` |
| 10 | u16 | `flags` | 写 `0` |
| 12 | u32 | `capacity` | 段总字节数 |
| 16 | u32 | `slot_count` | 槽数，≥ 1 |
| 20 | u32 | `slot_size` | 每槽字节数 |
| 24 | u32 | `meta_capacity` | meta 区字节数 |
| 28 | u32 | `payload_offset` | `64 + meta_capacity` |
| 32 | u32 | `max_readers` | `8` |
| 36 | u32 | `overflow_policy` | `0=overwrite`，`1=return` |
| 40 | u32 | `checksum_algo` | `0=none`，`1=crc32` |
| 44 | u32 | `stale_ms` | 心跳过期阈值。`return` 时 ≥ 1，默认 `1000` |
| 48 | i64 | `writer_epoch` | 本次 create 的随机值 |
| 56 | i64 | `writer_pid` | 创建者 PID，只供诊断 |

### 4.2 缓存行 1（偏移 64，发布热行）

| 偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 64 | i64 | `write_pos` | 下一个可写序号。release 发布 |
| 72 | — | reserved | 写 `0`。心跳不要放在这一行 |

### 4.3 缓存行 2（偏移 128）

| 偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 128 | i64 | `writer_heartbeat_ns` | 单调时钟纳秒，不是 Unix 毫秒。占 128–135 |
| 136 | i32 | `retainer_slot` | 当前占槽读者的槽号，没有时为 `-1`。`attach(role=retainer)` 用 CAS 从 `-1` 认领 |

### 4.4 读者槽（偏移 `192 + i * 64`，i = 0..7）

| 相对偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | i64 | `read_pos` | 下一个待读序号。空槽为 `-1` |
| 8 | i64 | `heartbeat_ns` | 单调时钟纳秒 |
| 16 | i64 | `generation` | 每次成功 `attach` 加 1 |
| 24 | u32 | `role` | `0=observer`，`1=retainer` |
| 28 | u32 | `state` | `0=empty`，`1=active`，`2=claiming`（认领中，失败会改回 empty） |
| 32 | u32 | `pid` | 诊断 |
| 36 | — | reserved | 填到 64 字节 |

attach 校验：

```
magic == 0x524D4853
version == 2
header_size == 1024
endian == 0x0102
capacity >= 1024 + slot_count * slot_size
slot_count >= 1
max_readers == 8
payload_offset == 64 + meta_capacity
slot_size > payload_offset
overflow_policy ∈ {0, 1}
checksum_algo ∈ {0, 1}
overflow_policy == 1 ⇒ stale_ms >= 1
```

任一不满足即拒绝，按 v1 布局去猜。

## 5. 槽

槽 `W` 的起始偏移：`1024 + (W % slot_count) * slot_size`。

槽头 64 字节，占一条缓存行。payload 从 `payload_offset` 开始。

| 相对偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | i64 | `seqlock` | 奇数 = 这一槽正在被覆盖；偶数 = 稳定 |
| 8 | i64 | `slot_seq` | 这一槽里的帧序号；空槽 `-1` |
| 16 | i64 | `stamp` | Unix 毫秒，只用于诊断，允许回拨 |
| 24 | u32 | `length` | payload 字节数 |
| 28 | u32 | `meta_len` | meta 有效字节数 |
| 32 | u32 | `checksum` | `checksum_algo=1` 时为 CRC32；否则写 `0` |
| 36 | u32 | `flags` | 写 `0` |
| 40 | — | reserved | 填到 64 字节 |

CRC32 覆盖 `meta_len` 字节的 meta，再接 `length` 字节的 payload（zlib / IEEE）。不算 meta 区里没用到的填充。

`payload` 和 `meta` 仍是不透明字节。连续性只看槽头的 `slot_seq`。库不解析采样率、样本起点或业务序号。

覆盖和 v1 一样会碰到「读者正在拷贝的那一槽」。用**这一槽自己的 seqlock**，不用全局 seqlock：写者动一个槽时，正在拷贝其他槽的读者不受影响。

奇数那次写入必须是全屏障。实现是 exchange：Windows 为自映射的 `lock xchg`，POSIX 为 `__atomic_exchange_*`（seq_cst），没有该符号时用同一套机器码。release 存储挡不住后面的 payload 写跑到奇数标记前面，不能用来把槽标成「写入中」。

## 6. 写

同一进程里多个线程调用 `publish()` 时，用进程内的锁串行。这把锁读者不拿，也不拿它去等任何人。一个段仍然只有一个写进程。段已存在时，第二个写者直接失败。重建段用 `unlink` 后再 create，或显式 `replace`（原地重置并更换 `writer_epoch`）。

```text
publish(payload, meta, stamp) -> PublishResult:
    超长 ⇒ CapacityError，不改环

    if overflow_policy == return and 存在活着的占槽读者
           and W - read_pos >= slot_count:
        return PublishResult(accepted=false, frame_id=None)
        # 不碰 seqlock，不碰 write_pos，不拷贝 payload

    base = 1024 + (W % slot_count) * slot_size
    seq_cst_store(seqlock, seqlock + 1)     # 变成奇数
    写 payload、meta
    写槽头：slot_seq=W, length, meta_len, stamp, checksum
    seq_cst_store(seqlock, seqlock + 1)     # 变成偶数
    release_store(write_pos, W + 1)
    W = W + 1
    return PublishResult(accepted=true, frame_id=W - 1)
```

「活着」指：`state==active`、`role==retainer`、`now - heartbeat_ns < stale_ms`。时钟是本机单调钟（Windows `QueryPerformanceCounter`，POSIX `CLOCK_MONOTONIC`）。不要用 Unix 毫秒做心跳。

`publish()` 的开头更新 `writer_heartbeat_ns`。两帧之间长时间空闲时调用 `heartbeat()`，避免读者把活着的写者看成已退出。

## 7. 读和提交

`read()` 不推进 `read_pos`。调用方处理完（旁路读者是显示，占槽读者是自己的落盘）再 `commit(seq)`。崩溃发生在提交前就再读一次；那一帧若已被覆盖，得到 `Gap`，而不是静默缺帧。

```text
read():
    刷新自己的 heartbeat_ns
    W = acquire_load(write_pos)
    R = 本地已提交游标          # 等于自己的 read_pos
    if R >= W:
        return None             # 没有新帧
    if W - R > slot_count:
        return Gap(dropped=W - slot_count - R, next_seq=W - slot_count)

    s1 = acquire_load(seqlock)
    if s1 为奇数 or slot_seq != R:
        重试若干次；仍然对不上 ⇒ 按上面的公式再判一次 Gap 或 None
    拷贝 payload 和 meta 到独立缓冲区
    s2 = acquire_load(seqlock)
    if s1 != s2:
        重试
    if checksum_algo==1 and crc 不符:
        raise ChecksumError     # 不提交，不跳到更新的序号
    return Frame(seq=R, stamp, payload, meta)


commit(seq):
    # seq 必须等于当前 read_pos，即刚刚 read() 到的那一帧
    release_store(read_pos, seq + 1)

skip_to(seq):
    # 只用于明确接受 Gap。seq 等于 Gap.next_seq，且 seq > read_pos
    release_store(read_pos, seq)
```

`read_batch()` 从当前游标起连续窥视。槽是稳定的就放进批次；遇到 `Gap` 或 `None` 就停。写者在此期间继续发布**不会**把已经窥视成功的帧作废，也不把整批丢掉。调用方对最后一帧 `commit`，或对 `Gap.next_seq` 执行 `skip_to`。

`ChecksumError` 表示这一槽损坏或实现错误。库不把游标拨到最新帧。

读者加入时默认站在当前 `write_pos`（`join=tip`），不承担历史。`join=window` 站到 `max(0, write_pos - slot_count)`，只读环里还在的那些帧。不允许把 `read_pos` 设到比窗口更老的位置；那样一个新的占槽读者会让 `return` 立刻开始交还。

`close()` 把本槽 `state` 写成 `empty`，`read_pos` 写成 `-1`。崩溃的读者不会自动让出槽位，8 个槽会漏到段销毁为止。它的心跳过期后不再参与 `return` 的占槽判断，因此漏掉的槽**不会**卡住写者。

## 8. 和其他路的关系

| 事件 | 写者 | 其他读者 | 这一路 |
| --- | --- | --- | --- |
| 旁路读者变慢 | 继续 `publish`，耗时不变 | 继续读到自己窗口里的帧 | `read()` 返回 `Gap`，要 `skip_to` 才继续 |
| 占槽读者变慢，策略是 `overwrite` | 继续写入 | 同上 | 同上。占槽身份在 `overwrite` 下不保护帧 |
| 占槽读者变慢但仍有心跳，策略是 `return` | 立刻 `accepted=false`，环不变 | 看不到被交还的新帧；已在环里的帧还在 | 提交之后，写者才恢复写入 |
| 占槽读者心跳过期 | 恢复写入，可以覆盖它没提交的帧 | 不受影响 | 若还活着，得到 `Gap` |
| 写者心跳过期 | — | 已在环里的帧仍可按 seqlock 读完；`writer_alive` 为假。不阻塞 | 同左 |

## 9. API

v1 的 `ShmRingWriter` / `ShmRingReader` 不改。v2 新类：

```text
ShmRingWriterV2(name, capacity, slot_count, meta_capacity,
                overflow="overwrite", stale_ms=1000, replace=False)
    publish(payload, meta=b"", stamp=None) -> PublishResult
    heartbeat()
    close() / unlink()

PublishResult
    accepted: bool
    frame_id: int | None

ShmRingReaderV2(name, role="observer", join="tip")
    read() -> Frame | Gap | None
    read_batch(limit=None) -> Batch
    commit(seq)
    skip_to(seq)
    heartbeat()
    writer_alive -> bool
    latest() -> Frame | None
    subscribe(callback, interval_ms=2) -> Subscription
    close()

Frame(seq, stamp, payload, meta)
Gap(dropped, next_seq)
Batch(frames, gap | None)
```

`latest()` 拷贝当前最新一帧，不改 `read_pos`。`subscribe` 在本进程起一个循环，默认每 2 ms 看一次 `write_pos`，序号变了就把这帧的拷贝交给回调。回调返回后循环继续。它不在 `publish()` 里运行，也不把帧送到别的进程。`Subscription.stop()` 结束循环，读者 `close()` 也会停掉它。回调抛错时循环停止，错误留在 `Subscription.error`。

上面是 Python 的名字。Node 用同名类和驼峰参数：`overflow`、`staleMs`、`checksum`、`replace`、`role`、`join`。`publish()` 返回 `{accepted, frameId}`。读出的帧是 `{seq, frameId, stamp, payload, meta}`，`seq` 与 `frameId` 相同。`readBatch()` 返回 `{frames, gap}`，`gap` 为 `{dropped, nextSeq}` 或 `null`。提交是 `commit(seq)`，接受缺口是 `skipTo(seq)`。`latest()` 与 `subscribe(callback, intervalMs)` 同 Python，结束用 `stop()`。

两端都提供这些类。错误类型在 v1 之上增加 `ChecksumError`。环满且策略为 `return` 时不抛异常，用 `accepted=false` 表示。

原子操作用 FFI，不用 `SharedArrayBuffer`。Python 创建的命名段不是 Node 的 SAB，`Atomics` 碰不到它。`write_pos` 和 seqlock 的写都是 exchange（全屏障），读是 `CAS(ptr, 0, 0)`，不改内存。

| 平台 | 实现 |
| --- | --- |
| Windows | `kernel32` 不导出 `InterlockedExchange64`。两端把 `lock xchg` / `lock cmpxchg` 映射成可执行页再调用 |
| Linux | 能加载到 `__atomic_exchange_8` / `__atomic_compare_exchange_8` 时用 libatomic 或 libc，memory order 为 seq_cst。否则用 x64 `lock xchg` 或 ARM64 `CASAL` / `SWPAL` |
| macOS | 先找 `libSystem` 里的同一组符号；没有就用上面的机器码 |

Node 经 `koffi` 调同一组入口。ARM64 机器码已写，尚未在 ARM 上单独跑过。

## 10. 验收

- 旁路读者睡数秒：`publish()` 耗时不变；跟得上的其他读者帧序号连续；睡着的那路醒来得到一次 `Gap`，`dropped` 等于被覆盖的帧数。
- `return`，占槽读者停止 `commit` 但继续心跳：`publish()` 马上返回 `accepted=false`，环里对应槽的字节不变，调用线程不堵在库内。
- 同上，心跳超过 `stale_ms`：随后的 `publish()` 重新 `accepted=true`。
- 没有占槽读者：`return` 也每次都写入。
- 拷贝过程中该槽被覆盖：返回的不是半新半旧的 payload；读者得到完整旧帧，或得到 `Gap` / 重试。
- CRC 不符：抛 `ChecksumError`，`read_pos` 不变。
- v1 单测与跨语言对拍保持原样通过。v2 另做 Python ↔ Node 对拍。

## 11. 不做

- 在 `publish()` 里睡眠、等事件、等最慢读者。
- 库内 spill 文件、落盘格式、回放 API。
- 解析 payload 里的 `block_seq` / `sample_start`。
- 校验失败后把游标跳到最新帧。
- 多写者。
- 崩溃读者的槽位自动抢占。v2 只忽略其过期心跳。
- 用 Unix 毫秒判断死活。
- 改 v1 段的布局或「最新优先、可丢」语义。

## 12. 相对 v1

| 项 | v1 | v2 |
| --- | --- | --- |
| 写者 | 无条件覆盖，全局 seqlock | 仍默认无条件覆盖；提交点改为 `write_pos` 的 release；防撕裂改为槽内 seqlock |
| 读者进度 | 进程内 `last_frame_id` | 共享 `read_pos`，只服务这一路的缺口、提交和 `return` 占槽判断 |
| 落后 | `dropped` 计数，批量期间 seqlock 变化会把整批丢掉且 `dropped=0` | 这一路得到 `Gap`；其他槽上已读出的帧保留 |
| 环满 | 不存在「满」，永远覆盖 | `overwrite` 仍永远覆盖；`return` 立刻交还，不阻塞 |
| 完整性 | `checksum` 写 0 | 可选 CRC32，失败即停在这一帧 |
| 版本 | `1`，头 64 B | `2`，头 1024 B。magic 相同，version 不同即拒绝 |

v1 代码位置：覆盖写在 `shmring/writer.py` 的 `publish()`，批量丢弃在 `shmring/reader.py` 的 `read_batch()`。
