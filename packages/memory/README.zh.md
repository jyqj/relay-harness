# memory/ — 长期记忆能力族

[English](README.md) | 中文

该能力族将受治理的跨会话记忆与支撑它的追加式会话证据分开。Provider 负责版本存储与检索；Consumer 决定召回数据何时进入 Agent 轮次或模型工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | 定义 Scope、证据、版本、召回与结算契约 | `ctx.longTermMemory` |
| [`memory-sqlite/`](memory-sqlite/README.md) | 在本地 SQLite 中存储规范版本与词法索引 | 提供 `ctx.longTermMemory` |
| [`memory-agent/`](memory-agent/README.md) | 在首个 step 召回，并于最终 `turn/end` 结算 | 消费 `ctx.longTermMemory` |
| [`tool-memory/`](tool-memory/README.md) | 暴露受治理的搜索、读取、记住、更新和遗忘工具 | 注册到 `ctx.tools` |

子系统参考见 [docs/subsystems/memory.md](../../docs/subsystems/memory.md)。
