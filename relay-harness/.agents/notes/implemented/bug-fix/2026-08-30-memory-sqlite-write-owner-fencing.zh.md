# Agent Note: 每次规范 Memory 写入都由当前 ownership 隔离

Status: implemented

[English](2026-08-30-memory-sqlite-write-owner-fencing.md) | 中文

## Problem

规范 Memory SQLite 存储包含多类数据变更：治理 revision、待结算 turn、访问计数、outcome reconciliation，以及提取队列准入与租约结算。若每类操作重复 `BEGIN IMMEDIATE`、心跳刷新和提交逻辑，幂等提前返回就可能在不检查当前 ownership 的情况下提交。数据语句之后才刷新 ownership 虽可依靠回滚保护数据库，却要求每个分支都必须到达最后的刷新语句。同进程 sibling handle 还共享一个进程身份；任一 sibling 在关闭时删除心跳，会使仍存活的 handle 失去 ownership。

## Decision

`SqliteLongTermMemory` 通过单一 `withOwnedWrite` 操作执行所有同步规范存储变更。它打开 `BEGIN IMMEDIATE`，在第一次领域数据变更前刷新 pid/boot-id owner row，然后执行操作并提交；ownership 或操作失败都会回滚事务。Signal insert 接收已准入的事务 handle，不再自行发现连接。待结算 turn 的 commit/abort 与提取 fail 验证会在事务内读取当前 row；提取失败还会在结算更新中检查租约截止时间。

进程认领按规范数据库路径计数引用。同进程 sibling provider 可以共享进程 owner，只有最后一个正常关闭的 handle 才会按 owner 条件删除对应 row。Ownership CAS 失败使用独立的 `MemoryStoreOwnershipError`；访问计数对普通存储失败仍保持 fail-open，但会传播该错误，确保已被取代的 Provider 不能继续执行由读取触发的写入。

## Alternatives considered

- **在每次操作的数据语句之后刷新**——拒绝，因为回滚虽能保护数据库，幂等或空分支仍可能绕过刷新，在未证明 ownership 时提交。
- **为每个 Provider 实例分配不同 owner 身份**——拒绝，因为存储承诺是每个路径由一个进程拥有，同进程 sibling handle 对连接级并发验证有实际用途。
- **运行后台心跳**——拒绝，因为 ownership 在写入发生时才需要生效；事务内隔离已经足够，也不会让空闲进程无限保持权威。

## Consequences

所有写入类型共享一个结算结构；另一活进程拥有存储时，操作会在领域数据变更前失败。长期空闲的进程仍可在 `ownerStaleMs` 后被取代，其下一次写入会显式失败。测试替换 owner 心跳并覆盖待结算 turn 的 prepare/commit/abort、搜索计数、新建与幂等 enqueue、过期终态 claim、complete、fail 和治理条目写入，随后验证全部领域 row 未变化。另一个双连接用例会关闭一个 sibling，并证明剩余 sibling 仍可 enqueue。
