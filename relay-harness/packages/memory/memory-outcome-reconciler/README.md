# @relay-harness/rlh-memory-outcome-reconciler

English | [中文](README.zh.md)

Host reconciler that derives idempotent Memory outcomes from the live-preferred logical Session corpus without resuming an Agent. It scans `context/prepared` for admitted Memory Evidence, observes the owning Assistant message and `turn/end`, reads durable message-feedback sidecars, and correlates explicit `goal/change` complete/block transitions to the latest prior recalled turn. Each Session reconciliation atomically replaces that Session's outcome set, so feedback rating changes and deletion retract stale observations. An unavailable feedback sidecar aborts replacement and preserves the last durable set; a failed full scan is retryable rather than memoized forever.

Only explicit positive/negative message ratings and durable Work completion affect bounded ranking. Ordinary retrieval, injection, completed turns, failed turns, and blocked Work remain neutral and inspectable; they are never relabeled useful. The initial persisted scan runs in the background with bounded concurrency, while live Session events and `message-feedback/changed` schedule per-Session refreshes.

## Model Experience

### No direct model request

#### What the model sees

Nothing. This package reads `context/prepared`, Session outcomes, and message feedback and writes provider-neutral Memory outcome observations; it never assembles model content.

#### Token effect

Zero direct tokens. Later `memory-agent` search may reorder candidates by at most the canonical provider's bounded outcome adjustment.

#### KV Cache effect

No request or prefix mutation occurs here. A later non-prefix Memory Context contribution may contain a different ranked set.

## Known Limitations and Deferred Work

- Work completion is correlated to the latest prior turn that admitted Memory Evidence; it is explicit positive outcome evidence, not proof that one individual memory caused completion.
- `goal/change` block and ordinary turn outcomes remain neutral because failure causality is not established.
- No semantic conflict provider is bundled; the optional seam is deployment-owned.

