# `@relay-harness/rlh-memory`

English | [中文](README.zh.md)

Service Definitions for `ctx.longTermMemory` and `ctx.memoryExtractionQueue`. They define exact user/workspace/agent scope, append-only logical revisions, durable SessionEvent evidence, governed status and trust, ranked search, side-effect-free paged governance listing, deterministic conflict review, canonical signals, idempotent outcome reconciliation, prepare/commit/abort host-turn settlement, and restart-safe automatic-extraction jobs. Providers implement storage, retrieval, and queue ownership; Agent, extraction, and tool Consumers keep their own prompt and authorization policy.

`MemoryEntry` is the current materialized view. A provider must retain prior revisions even when `revise()` or `forget()` changes that view; both requests may carry `expectedRevision` for provider-atomic compare-and-set governance. `active` entries require `user-stated` or `action-verified` trust; candidate, disputed, superseded, and tombstoned states remain explicit rather than silently overwriting history.

## Model Experience

Indirectly, through `@relay-harness/rlh-memory-agent` recall messages, `@relay-harness/rlh-memory-extractor-llm` auxiliary requests, and `@relay-harness/rlh-tool-memory` tool calls.

#### KV Cache effect

This package emits no request content; each Consumer owns its own cache effect.

## Known Limitations and Deferred Work

- **No provider registry** — exactly one `ctx.longTermMemory` provider exists in a Cordis realm; deployments replace that provider through composition.
- **No embedding contract yet** — provider-independent search exposes retrieval channels, but semantic-vector configuration is deferred to a later provider seam.
