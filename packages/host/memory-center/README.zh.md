# @relay-harness/rlh-host-memory-center

[English](README.md) | 中文

canonical `ctx.longTermMemory` 服务之上的 Host `memoryCenter` Remote。`list`、`search` 与 `read` 要求附着的 `sessionId`；Host 从 durable cwd 推导 Scope，并拒绝 Client 提交的不匹配 `workspaceId`。读取始终限定在精确的 `(workspaceId, 配置的 userId, 配置的 agentId)` Scope 内，且不改变 recall 使用计数。详情读取返回 durable 来源证据、从 `validUntil` 推导的 freshness、canonical signal/outcome history，以及通过同 Workspace Session Query 语料聚合且不激活 Agent 的已准入 Memory Evidence。每次使用会把当时准入的 revision 标为 current、historical 或 unknown。多页治理搜索遇到重排会重试；持续 churn 时 fail loud，不返回跳过或重复的行。

`approve`、`reject`、`revise` 与 `delete` 需要已连接 Session，以及用户操作时看到的 revision。Host 从该 Session 的 `cwd`（缺失时为 `global`）推导 mutation Scope，追加一条 `memory/governance-requested` 事实，要求 Session durability barrier 确实参与，在 barrier 后重新检查 expected revision，最后才把其精确 seq 作为 user-statement Evidence 写入 append-only Provider revision。批准只会提升 candidate/disputed row 并建立 `user-stated` trust；拒绝和删除追加 tombstone。没有操作会物理抹除 revision 历史，也不会虚构 retention policy。

## 模型体验

### 不直接发起模型请求

#### 模型看到什么

什么也看不到。本包既不组装也不发送模型请求；`memoryCenter` Remote 只读取和变更 canonical Memory record。

#### Token 影响

治理当下为零 token。治理发生后，后续 `memory-agent` 请求可能准入不同的 Memory Context contribution。

#### KV Cache 影响

治理当下不会改变请求或 cache prefix。后续 recall 可能改变非 prefix 的 Memory Context message。

## 已知限制与暂缓事项

- 默认不捆绑 semantic conflict provider；optional provider 发现仍是带 attribution 的 candidate，绝不覆盖用户 review。
- Work completion 是最近一次此前 recalled turn 的 positive outcome Evidence，不证明某条 memory 导致完成。
- Retention 仍由 provider policy 拥有：Center 展示 expiry 并追加 tombstone，但不物理删除 revision history。
