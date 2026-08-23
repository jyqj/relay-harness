# `@deepseek-ai/dsh-memory-sqlite`

[English](README.md) | 中文

`ctx.longTermMemory` 与 `ctx.memoryExtractionQueue` 的规范本地 Provider。SQLite 为每个追加式版本保存完整 JSON 快照，同时保存当前物化行、Unicode 与 trigram FTS5 索引、待结算轮次、访问信号以及可跨重启恢复的提取 job。当前行和 FTS 在同一个 `BEGIN IMMEDIATE` 事务中更新；tombstone 仍可按精确 id 读取，但会离开召回索引。

Provider 会拒绝无关数据库和未知的规范 schema 版本。缺失目录和数据库文件在 POSIX 文件系统中以 owner-only 权限创建。Scope 谓词始终包含工作区、用户和 Agent 身份。自动 `prepare()` 仅搜索未过期的 `active` 条目；显式搜索可请求 candidate 或 disputed 状态。

Active 写入要求用户陈述或成功工具结果证据。常见私钥、访问令牌、密码和 API Key 形式会在 Provider 操作中同时从 content 与 summary 被拒绝，因此其他 Consumer 无法绕过工具检查。按规范化 kind/content 做精确去重会返回已有 identity，并可晋升匹配的 candidate，而不是创建分叉。当被记住的内容与一条已死的 `superseded` 或 `tombstoned` 条目精确匹配时，新 identity 记录 `supersedes`，死条目获得带反向 `supersededBy` 链接的 `superseded` 版本，两者在同一事务内写入；`forget` 只追加 tombstone，从不写 supersede 链。

每次搜索或召回命中都会在 fail-open 事务中递增 `usefulAccessCount`，而已提交的注入递增 `accessCount`。该计数无法提交时，检索与召回仍然可用。

每个规范数据库路径由一个进程拥有。Provider 在启动时认领一条 pid/boot-id 心跳记录，在每个写事务内刷新它，并在正常关闭时释放；遇到新鲜的他进程心跳时启动会显式失败（过期心跳可被重新认领），被取代的 owner 之后的写入也会显式失败，而不是静默共写。

提取 admission 按 Scope、session、turn 与 source hash 幂等；去重检查与插入共享同一个 `BEGIN IMMEDIATE` 事务，因此来自不同连接的并发 enqueue 只会准入一个 job。原子 claim 会增加 attempts 并携带有期限的 worker lease；过期 lease 可被重新领取，而最终一次过期会进入 terminal failed。成功 job 只保留 memory id、计数和 output hash，不保存原始模型输出。schema version 3 增加单 owner 心跳表；version 2 增加了确定性 content hash，version-1 store 会在队列启用前就地迁移。

## 配置

| Key | 默认值 | 契约 |
|---|---:|---|
| `path` | 必填 | 规范数据库路径；测试支持 `:memory:`。 |
| `journalMode` | `wal` | `wal`、`delete`、`truncate` 或 `persist`。 |
| `maxSearchLimit` | `50` | 可接受的最大结果上限。 |
| `maxContentChars` | `8000` | 记忆内容的最大 Unicode code point 数。 |
| `maxSummaryChars` | `500` | 摘要的最大 Unicode code point 数。 |
| `ownerStaleMs` | `30000` | 他进程 ownership 心跳被视为失效的时限。 |

## 模型体验

无，因为该受信任 Provider 只向 Consumer 返回条目，不注册面向模型的提示词、schema、工具或消息。

#### KV 缓存影响

无；本包既不组装也不发送 Provider 请求。

## 已知限制与延期工作

- **同步 SQLite 语句** — `DatabaseSync` 执行语句期间会阻塞 JavaScript 线程。
- **单进程 Owner，以心跳强制** — 一个规范数据库路径只能由一个活跃 Provider 与进程内 worker 拥有。新鲜的他进程心跳会让启动和后续写入显式失败；长期空闲的 reader 不再刷新心跳，可能被新 owner 取代。仍不支持外部写入者和分布式 worker。
- **用户复核信号待建** — 信号存储接受 `user_confirmed` 与 `user_rejected`，但当前没有任何复核界面发出它们；在该 Consumer 出现之前，所有记录的信号都是 `candidate_hit` 或 `injected`。
- **forget 不产生 supersede 链** — `forget` 只 tombstone、不写 supersede 链接，因为删除没有替代者；只有同一内容被再次记住时才形成链。
- **仅词法检索** — 当前融合 Unicode／trigram FTS、importance 与 trust；尚无语义 embedding。
