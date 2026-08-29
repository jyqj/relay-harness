# @relay-harness/rlh-client-ui-memory-center

English | [中文](README.zh.md)

Web Settings Memory Center. The Client cache keys list/search pages by their exact scope and filters, caches details separately, clears on connection reset, and invalidates both after every governance mutation. A cache generation prevents an older in-flight read from repopulating state after invalidation. The page exposes all canonical statuses, query and status filtering, pagination, visible expiry/freshness, source excerpts, confidence/trust/importance, attributed conflict comparisons, cross-session admitted why-used traces with historical/current revision labels, canonical signals, and outcome-backed ranking detail.

Candidate/disputed rows can be approved or rejected. Every mutation carries the displayed `revision`, so a stale detail cannot overwrite newer governance. Non-terminal rows can be revised with content, summary, importance, confidence, and `validUntil`, or tombstoned with a required reason. All reads and mutations are disabled without an active session because the Host must persist a user governance event as evidence. The UI calls deletion “delete” for product clarity while explicitly explaining that canonical history is retained as a tombstone.

## Model Experience

### No direct model request

#### What the model sees

Nothing. This browser package never assembles or sends a model request; it calls the `memoryCenter` management Remote.

#### Token effect

Zero tokens in the browser. A later `memory-agent` request may admit a different Memory Context contribution after governance changes.

#### KV Cache effect

No request or cache prefix changes in this package. Later recall may change the non-prefix Memory Context message.

## Known Limitations and Deferred Work

- Semantic conflicts appear as attributed review candidates; the UI never presents provider inference as canonical truth.
- Outcome history is bounded to the 50 most recent observations in one detail response.
