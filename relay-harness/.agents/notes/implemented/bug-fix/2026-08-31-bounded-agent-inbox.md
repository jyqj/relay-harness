# Agent Note: Bounded Agent inbox retention

Status: implemented

English | [中文](2026-08-31-bounded-agent-inbox.zh.md)

## Problem

An Agent owned durable `next-turn` and `next-step` queues, but their aggregate live retention had no deployment limit. A stalled Agent or a producer faster than the model loop could therefore retain an arbitrary number of complete `UserMessage` values and durable splice events.

## Decision

`AgentLoop` owns a deployment-only `maxPendingInboxMessages` limit, defaulting to 4096 across both pending lists. `Inbox` validates the projected aggregate before appending a live `agent/inbox/spliced` event, so an over-limit insertion publishes neither durable state nor live notifications. Replacement and removal continue to work at the cap.

Persisted inbox state is replayed without enforcing a newly lowered cap. This deliberately grandfathers existing state so a deployment can resume and drain it; only a later live mutation that would remain above the cap is refused. The constructor still rejects invalid capacity values, and the plugin schema plus direct-construction validation require a positive safe integer.

## Alternatives considered

**Drop the oldest pending prompt.** Rejected because it silently loses accepted user work and invents queue semantics that callers cannot observe reliably.

**Apply the cap while replaying persisted events.** Rejected because lowering configuration could make an otherwise valid Session permanently unloadable, preventing cancellation or draining.

**Expose the cap as live Settings.** Rejected because it is a deployment resource policy rather than user-owned model behavior. A restart makes the new admission policy explicit while preserving already durable work.

## Consequences

Every concrete `ReactLoopAgent` now has finite pending-message admission by default. Producers receive a typed `InboxCapacityError` before commit and can retry after work drains. The cap counts messages, not serialized bytes; attachment and content byte budgets remain separate seams and may need their own limits.
