# Agent Note: A re-prompt for a released SDK session id resumes its durable log

Status: implemented

English | [中文](2026-09-03-sdk-close-reprompt-resume.zh.md)

## Problem

The SDK close-contract coverage note ([sdk-close-real-runtime-coverage](../testing/2026-09-03-sdk-close-real-runtime-coverage.md)) recorded two defects its probes pinned around. Re-prompting a closed session id was accepted by the SDK server but died at the persistence coordinator: the fresh empty session collided with the closed id's durable log (`adoptLivePrefix` → `seedCoversPrefix`), the turn ended with `turn/end { kind: 'error' }` carrying `(id collision)`, and nothing of the fresh session persisted. The close contract promises that "a later prompt for the id creates a fresh session", so the documented flow was broken. The second defect — a close landing before the first streamed chunk skipping `turn/end` — no longer reproduces on the current agent-loop: a dispose-cause cancel in the pre-first-chunk window already appends the terminal `turn/end { kind: 'aborted' }`, at the loop level and on the real runtime.

## Decision

`HarnessSdkJsonRpcServer.createSession` reattaches a released id through the agent registry's `resume` path instead of always calling `create`: it tries `agents.resume` first, and falls back to `agents.create` when the identity has no durable log to resume (first use, a lifecycle closed before its first append, or a deployment without the persistence service). The id IS the persistence identity, so a fresh session constructed over a released id can neither adopt the stored log (a constructed Session cannot be seeded retroactively, and the coordinator's own create path refuses a second artifact per id) nor replace it (both first-party backends refuse to materialize over an existing log). Resuming is therefore the only contract-restoring direction available without a destructive backend reset, and it matches the in-process behavior the same caller already sees: two `run()` calls with one named id continue the conversation, so closing and re-prompting continues it too. A real load failure (corruption, backend error) resurfaces through the fallback create attempt's own persistence probe, which refuses the same identity, so the fallback swallows only the no-log case.

For the pending-close window, the change adds regression coverage rather than a fix: `MockAdapter` gains a `hang-before-start` entry (cancel-terminated hold before any chunk), `cancel.spec.ts` pins that a disposed-cause cancel in that window still ends the turn aborted with no chunks streamed, and the TypeScript snapshot close suite gains a `close-pending` probe that closes on the real runtime while the replay stream hangs before its first chunk and asserts the wire event and the durable log both end with `turn/end { kind: 'aborted' }`. The Python `sdk-close` smoke mirrors both follow-ups: a re-prompt of the closed named id that must complete durably, and a pending close whose withheld mock response is aborted into the same `turn/end` vocabulary. The `close-pending` replay sidecar needed a hang-before-output entry, so `llm-replay`'s `hang` override entry gained a validated `beforeStart: true` variant that skips its two-chunk prefix.

## Alternatives considered

**Start a clean new log for the released id in the persistence coordinator.** Rejected: both the coordinator and the backends make this impossible without new destructive surface. A constructed live Session cannot be seeded after the fact, `createCore` refuses any create over a persisted identity ("load/resume it instead"), and the JSONL backend refuses to materialize over an existing log by design. Erasing the closed turn's durable log to satisfy a re-prompt would trade a wire-contract bug for silent durability loss.

**Scope the collision guard to concurrent lifecycles and delete the retired artifact on recreate.** Rejected for the same destructive-reset cost, plus a tombstone lifetime problem: the coordinator would have to retain every released id forever (an unbounded table) or guess when a tombstone expires, and the deletion would still need a new backend seam member implemented by every backend.

**Fail the re-prompt loud at the server and tell callers to use a new id.** Rejected: it turns a documented contract ("a later prompt for the id creates a fresh session") into an error and changes the SDK wire surface for every existing caller.

## Consequences

The re-prompt-after-close flow completes and persists on both SDKs: the TypeScript snapshot suite pins it with the keyless `close-reprompt` probe, the server suite pins the dispatch contract (resume wins when the id has a log, create only on the no-log fallback) and the real-composition reattach (the second model request carries the first turn's history), and the Python smoke mirrors the flow against the mock model. The pending-close window is pinned at three levels — agent-loop unit, llm-replay entry semantics, and the real-runtime probe — so the two cancellation windows can no longer drift apart silently. The cost: a re-prompt of a closed id continues the id's prior conversation instead of starting an empty one; callers who want a blank history under a familiar id must mint a new id, and the server/client close documentation now says the fresh session resumes the id's durable log.
