# Agent Note: Durable continuable-subagent delivery

Status: implemented

English | [中文](2026-08-31-durable-continuable-subagent-delivery.zh.md)

## Problem

A continuable child persisted its Session and descriptor, but initial prompts and follow-ups became durable only after AgentLoop claimed them into `user/message`. Returning a `MessageId` at inbox acceptance therefore overstated recovery: a process failure in that gap lost accepted work, and a caller retry had no stable idempotency key or receipt lookup.

## Decision

The child Session is the durable delivery mailbox. Before an initial prompt or follow-up enters the Agent inbox, the continuation manager appends `subagent/delivery-accepted { version, idempotencyKey, message }` and awaits the Session durability barrier. The returned `MessageId` identifies that stored message and is the acceptance receipt. `SubagentFollowupOptions.idempotencyKey` lets a caller retry across an uncertain response; identical content and source return the original receipt, while conflicting reuse fails.

When the accepted message reaches the model-visible `user/message` log, the manager appends `subagent/delivery-claimed`. The mailbox projection also treats `user/message` itself as claimed, so a crash after model-visible commit but before the acknowledgement cannot duplicate delivery. Cold materialization folds only the child's own suffix, replays accepted-unclaimed messages in commit order, then accepts the caller's new follow-up. A delivery durably committed while its Activation begins disposal stays pending for the next cold materialization instead of entering a closing handle.

The Agent inbox remains the only execution FIFO. Durable mailbox events describe recovery ownership, not a second scheduler: replay submits each pending identified message through `Agent.followup()`, after which AgentLoop owns turn ordering normally.

Retry identity compares the normalized message structures, not JSON property insertion order. Reordering object fields preserves the original receipt; changing content, attribution, or report delivery mode remains a conflict. Array order remains significant.

Every same-key retry crosses the persistence barrier again: an in-memory accepted event may belong to a caller whose earlier flush failed. Recovery preserves the original message identity and republishes it only when the authoritative log and inbox do not already contain it. Active publication rechecks the child lease after the asynchronous barrier; a report resolves its live parent again before parent inbox mutation.

## Alternatives considered

**Persist only the caller's raw content in a separate queue database.** Rejected because the child Session already owns durable ordering, source attribution, version refusal, repair, and flush semantics; another store would require a transaction across two authorities.

**Acknowledge on inbox claim.** Rejected because claim precedes `user/message`; a crash after that acknowledgement but before the model-visible append would lose the delivery. The surface event is the commit point, with an explicit acknowledgement as a compact projection aid.

**Return a new receipt object.** Rejected because the existing `MessageId` already identifies the exact durable `UserMessage` across inbox, log, and retry. Adding a route/status wrapper would duplicate lifecycle state without increasing guarantees.

**Add cross-process Activation leasing in the same change.** Rejected because it requires backend-wide lease schema, renewal, fencing, and takeover semantics. The mailbox closes message loss for the supported single-process owner; concurrent processes remain unsupported until a complete lease protocol exists.

## Testing

Continuation tests interrupt the process-local Activation with an accepted message still unclaimed, start a fresh runtime over the same JSONL persistence, and prove the old delivery enters history before a new follow-up. They also prove same-key retry returns one receipt, persists one accepted event, and executes the content once. The complete subagent package suite covers existing cancellation, drain, disposal, cold-resume, and ordering races with the durability barrier in place.

## Consequences

An accepted initial prompt or follow-up survives process restart without waiting for its turn to begin. Callers can safely retry an uncertain follow-up response when they retain an idempotency key. Returning the receipt requires immediate durability of the accepted event. A claimed event is appended after model-visible admission. Activation residency remains process-local; deployments enabling the [fenced lease protocol](2026-09-05-persistence-commit-takeover-exclusion.md) serialize cross-process ownership and child persistence mutations.
