# @relay-harness/rlh-context-inspector

English | [中文](README.zh.md)

Bounded whole-log Session Projection for durable `context/prepared` facts. It retains the deterministic retrieval plan and selected/rejected decisions, links each selected contribution to exact admitted `user/message` seqs, and preserves rejected/rewritten empty links, Evidence provenance, source/path/revision, freshness, verification, truncation, Coverage, and provider-owned why-used reasons. The latest 50 traces and 500 message facts are retained; older trace count remains visible.

## Model Experience

### No direct model request

#### What the model sees

Nothing directly. No `user/message` is added; this package observes or manages already-derived context/index state and never assembles a model request.

#### Token effect

Zero tokens directly. Later context retrieval may change only after an explicit index or governance operation.

#### KV Cache effect

No request-prefix or cache-key change is introduced by this package.

## Known Limitations and Deferred Work

- The bounded projection omits trace bodies older than 50 entries. Why-used falls back to contributor attribution when provider domain metadata carries no `selectionReason`, `reasons`, or `matchedBy`.
