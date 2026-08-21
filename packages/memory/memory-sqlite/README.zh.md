# `@deepseek-ai/dsh-memory-sqlite`

[English](README.md) | 中文

规范的本地 `ctx.longTermMemory` Provider。SQLite 为每个追加式版本保存完整 JSON 快照，同时保存当前物化行、Unicode 与 trigram FTS5 索引、待结算轮次以及访问信号。当前行和 FTS 在同一个 `BEGIN IMMEDIATE` 事务中更新；tombstone 仍可按精确 id 读取，但会离开召回索引。

Provider 会拒绝无关数据库和未知的规范 schema 版本。缺失目录和数据库文件在 POSIX 文件系统中以 owner-only 权限创建。Scope 谓词始终包含工作区、用户和 Agent 身份。自动 `prepare()` 仅搜索未过期的 `active` 条目；显式搜索可请求 candidate 或 disputed 状态。

Active 写入要求用户陈述或成功工具结果证据。常见私钥、访问令牌、密码和 API Key 形式会在 Provider 操作中被拒绝，因此其他 Consumer 无法绕过工具检查。

## 配置

| Key | 默认值 | 契约 |
|---|---:|---|
| `path` | 必填 | 规范数据库路径；测试支持 `:memory:`。 |
| `journalMode` | `wal` | `wal`、`delete`、`truncate` 或 `persist`。 |
| `maxSearchLimit` | `50` | 可接受的最大结果上限。 |
| `maxContentChars` | `8000` | 记忆内容的最大 Unicode code point 数。 |
| `maxSummaryChars` | `500` | 摘要的最大 Unicode code point 数。 |

## 模型体验

无，因为该受信任 Provider 只向 Consumer 返回条目，不注册面向模型的提示词、schema、工具或消息。

#### KV 缓存影响

无；本包既不组装也不发送 Provider 请求。

## 已知限制与延期工作

- **同步 SQLite 语句** — `DatabaseSync` 执行语句期间会阻塞 JavaScript 线程。
- **单进程 Owner** — 一个规范数据库路径只能由一个活跃 Provider 拥有；不支持外部写入者和多进程共享。
- **仅词法检索** — 当前融合 Unicode／trigram FTS、importance 与 trust；尚无语义 embedding。
