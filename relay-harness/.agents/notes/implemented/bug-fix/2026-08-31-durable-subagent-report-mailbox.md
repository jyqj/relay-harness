# Agent Note: Durable subagent report mailbox

Status: implemented

English | [中文](2026-08-31-durable-subagent-report-mailbox.zh.md)

## Problem

`reportFrom()` returned a parent inbox identity but retained no durable child-side delivery fact. A crash after the child reported and before the parent logged the message lost the report; a retry could duplicate it because neither side owned an idempotency record.

## Decision

The reporting child Session owns an outbound mailbox. Before parent inbox publication, `reportFrom()` appends and flushes `subagent/report-accepted { version, idempotencyKey, delivery, message }`. The stored message already contains its stable `MessageId`, source attribution, framing, and quiet/next-step policy. Same-key identical retries return the original receipt; conflicting reuse fails.

When the parent appends the matching `user/message`, the live manager appends `subagent/report-delivered` to the child. Cold child materialization also treats the parent's durable log or current inbox as authoritative acknowledgement, so a crash after parent admission but before the child acknowledgement does not duplicate the report. Remaining accepted reports replay in commit order before the resumed child receives new work.

## Alternatives considered

**Store reports in the parent before sending.** Rejected because a report begins under child authority and the child Session is the only durable object guaranteed live at acceptance; cross-Session atomic append does not exist.

**Use only the parent inbox as the receipt.** Rejected because inbox state is process-local and disappears on restart.

**Add a background report pump.** Rejected for this slice: waking cold children solely for outbound delivery needs independent scheduling and cross-process ownership. Recovery occurs when the child next materializes.

## Testing

Tests persist a quiet report while the parent has not claimed it, retry the same idempotency key, tear down the process-local Activation, cold-resume from JSONL, and assert exactly one original-id report appears in the fresh parent inbox. Existing next-step reporting and the complete continuation suite remain green.

## Consequences

Accepted reports survive single-owner process restart and retry without loss or duplication. Each report pays one pre-delivery child-session flush and one later acknowledgement event. The direct parent must be live at initial acceptance, and recovery waits for later child materialization. Activation leasing remains process-local; this mailbox does not permit two Harness processes to deliver concurrently.
