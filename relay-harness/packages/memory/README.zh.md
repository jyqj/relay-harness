# memory/ — 长期记忆能力族

[English](README.md) | 中文

该能力族将受治理的跨会话记忆与支撑它的追加式会话证据分开。Provider 负责版本存储与检索；Consumer 决定召回数据何时进入 Agent 轮次或模型工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | 定义 Scope、证据、版本、召回、结算与提取 job 契约 | `ctx.longTermMemory`、`ctx.memoryExtractionQueue` |
| [`memory-sqlite/`](memory-sqlite/README.md) | 在本地 SQLite 中存储规范版本、词法索引与提取 job | 提供两个 memory service |
| [`memory-agent/`](memory-agent/README.md) | 用于 Agent 召回／结算与无副作用 Prompt Enhancement 查询的 Context Provider | 消费 `ctx.longTermMemory`，向 `ctx.contextEngine` 贡献 |
| [`memory-outcome-reconciler/`](memory-outcome-reconciler/README.md) | 不激活 Agent 地 reconciliation persisted Session、message-feedback 与 Work outcome | 提供 `ctx.memoryOutcomeReconciler`，消费 `ctx.longTermMemory` |
| [`memory-extractor-llm/`](memory-extractor-llm/README.md) | 捕获已完成轮次并持久提取有证据约束的版本 | 消费两个 memory service 与 `ctx.llm` |
| [`tool-memory/`](tool-memory/README.md) | 暴露受治理的搜索、读取、记住、更新和遗忘工具 | 注册到 `ctx.tools` |

子系统参考见 [docs/subsystems/memory.md](../../docs/subsystems/memory.md)。
