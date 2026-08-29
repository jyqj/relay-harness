# @relay-harness/rlh-host-code-index-center

English | [中文](README.zh.md)

Typed Host Remote for Session-scoped Code Index management status, incremental refresh, embedding reconciliation, confirmation-gated destructive rebuild, and compact search diagnostics. The Host resolves `sessionId` to its durable cwd before binding `ctx.codeIndex`; Clients cannot supply a filesystem root. Query length, path count, and top-K are bounded on the Host.

## Model Experience

### No direct model request

#### What the model sees

Nothing directly. No `user/message` is added; this package observes or manages already-derived context/index state and never assembles a model request.

#### Token effect

Zero tokens directly. Later context retrieval may change only after an explicit index or governance operation.

#### KV Cache effect

No request-prefix or cache-key change is introduced by this package.

## Known Limitations and Deferred Work

- A Session without a workspace cwd is intentionally unavailable; the Center never falls back to process cwd or another Session.
