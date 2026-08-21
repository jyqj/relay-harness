# memory/ — long-term-memory capability family

English | [中文](README.zh.md)

This family keeps governed cross-session memory separate from the append-only session evidence that supports it. Providers own revision storage and retrieval; Consumers decide when recalled data enters an Agent turn or a model tool.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Defines scope, evidence, revision, recall, and settlement contracts | `ctx.longTermMemory` |
| [`memory-sqlite/`](memory-sqlite/README.md) | Stores canonical revisions and lexical indexes in local SQLite | provides `ctx.longTermMemory` |
| [`memory-agent/`](memory-agent/README.md) | Recalls on the first step and settles at final `turn/end` | consumes `ctx.longTermMemory` |
| [`tool-memory/`](tool-memory/README.md) | Exposes governed search, read, remember, update, and forget tools | registers on `ctx.tools` |

The subsystem reference is [docs/subsystems/memory.md](../../docs/subsystems/memory.md).
