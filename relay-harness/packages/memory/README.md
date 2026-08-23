# memory/ — long-term-memory capability family

English | [中文](README.zh.md)

This family keeps governed cross-session memory separate from the append-only session evidence that supports it. Providers own revision storage and retrieval; Consumers decide when recalled data enters an Agent turn or a model tool.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Defines scope, evidence, revision, recall, settlement, and extraction-job contracts | `ctx.longTermMemory`, `ctx.memoryExtractionQueue` |
| [`memory-sqlite/`](memory-sqlite/README.md) | Stores canonical revisions, lexical indexes, and extraction jobs in local SQLite | provides both memory services |
| [`memory-agent/`](memory-agent/README.md) | Recalls on the first step and settles at final `turn/end` | consumes `ctx.longTermMemory` |
| [`memory-extractor-llm/`](memory-extractor-llm/README.md) | Captures completed turns and extracts evidence-grounded revisions durably | consumes both memory services and `ctx.llm` |
| [`tool-memory/`](tool-memory/README.md) | Exposes governed search, read, remember, update, and forget tools | registers on `ctx.tools` |

The subsystem reference is [docs/subsystems/memory.md](../../docs/subsystems/memory.md).
