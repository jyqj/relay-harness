# `@deepseek-ai/dsh-memory`

English | [中文](README.zh.md)

Service Definition for `ctx.longTermMemory`. It defines exact user/workspace/agent scope, append-only logical revisions, durable SessionEvent evidence, governed status and trust, ranked search, and prepare/commit/abort host-turn settlement. Providers implement storage and retrieval; Agent and tool Consumers keep their own prompt and authorization policy.

`MemoryEntry` is the current materialized view. A provider must retain prior revisions even when `revise()` or `forget()` changes that view. `active` entries require `user-stated` or `action-verified` trust; candidate, disputed, superseded, and tombstoned states remain explicit rather than silently overwriting history.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-memory-agent` recall messages and `@deepseek-ai/dsh-tool-memory` tool calls.

#### KV Cache effect

This package emits no request content; each Consumer owns its own cache effect.

## Known Limitations and Deferred Work

- **No provider registry** — exactly one `ctx.longTermMemory` provider exists in a Cordis realm; deployments replace that provider through composition.
- **No embedding contract yet** — provider-independent search exposes retrieval channels, but semantic-vector configuration is deferred to a later provider seam.
