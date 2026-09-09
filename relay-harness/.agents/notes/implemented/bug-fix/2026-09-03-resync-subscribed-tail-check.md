# Agent Note: Reconnect baseline tail check on the session/subscribed frame

Status: implemented

English | [中文](2026-09-03-resync-subscribed-tail-check.zh.md)

## Problem

The client had a gap-repair branch that could never fire on the path it was written for. `doOpen` pulls the tail page and, if a `session/subscribed` baseline has already arrived past the window tail, pulls once more to stitch the lost span. That predicate reads `subscribedLastSeq`, which `resync()` sets to `null` at rebuild — and on the resync (reconnect) path the fresh generation's subscribed frame cannot have arrived yet: `ConnectionController` runs `host.describe`, awaits the full `onConnected` hydration (which is what drives `resync`), and only then opens the mux stream. The frame arrives strictly after `doOpen`'s check ran, so on reconnects the branch was dead code.

The consequence is silent tail loss, not staleness alone. A forced stream close (the `FrameQueue` byte budget ends the queue; the SSE client reconnects) drops every session event emitted inside the closed window — the reopened mux replays only baselines (subscription, queue, jobs, pending), never events. The only guard for that loss was the never-firing branch; when the lost events happened to be the turn's last increments or its `turn/end`, the conversation window kept a stale tail until the next prompt, with no error anywhere. The lazy first-open path was unaffected: there the stream is already running when the user opens a session, so the subscribed frame genuinely can precede `doOpen`.

Two comments asserted the opposite of the production order (`onConnected` racing the mux frames, "reconnect replays flow from stream open, ahead of onConnected"), and the `FrameQueue` retention contract claimed "termination loses no state" on the strength of a full-baseline replay that does not carry events.

## Decision

**The `session/subscribed` branch performs a tail check when the window is open.** Same predicate as `doOpen`'s stitch pull (`frame.lastSeq > windowTailSeq()`, non-null tail): when it holds, the branch calls the existing `repairGap()` — the resync-lite tail-page repull that routes through `installWindow`, reuses the `stitching` re-entry guard, and drops its result if a full resync superseded the generation meanwhile. The lazy-open path is untouched: while `openState` is not `open` the branch only records the baseline, and `doOpen`'s own second pull stays the owner of that case.

**Comments now state the real ordering.** The `resync` comment explains that hydration completes before the stream opens and points at the subscribed-frame tail check as the closed-window guard; the `onStateChange` comment drops the inverted parenthetical; the `FrameQueue` retention contract says the re-open replays baselines only and names the client-side tail check plus backfill as the recovery path for in-window events.

## Alternatives considered

**Preserve the previous generation's `subscribedLastSeq` through resync and check again after `doOpen` lands the window.** Rejected: it threads a stale-generation number across the rebuild and still needs a second check site at subscribe time for the frame that arrives mid-rebuild; the subscribed-branch check is one site with the same predicate the codebase already owns.

**Reorder `ConnectionController` to open the streams before awaiting `onConnected`.** Rejected: the await-then-pump order exists so unary calls (session list, history) occupy the HTTP pool before two long-lived streams — the comment at the handshake documents the mobile per-origin slot exhaustion it prevents.

## Consequences

A reconnect after a forced stream close now backfills events lost inside the closed window as soon as the fresh generation's subscribed frame lands, instead of leaving a stale tail until the next prompt; the previously dead repair branch is exercised on its intended path. Lazy first opens, non-subscribed sessions (`subscribedLastSeq` stays `null`, the liveBuffer dedup path), and the existing doOpen stitch pull keep their behavior. Three focused cases in `session.client.spec.ts` pin the backfill, the no-op below the tail, and the cold-path handoff to `doOpen`; the direction-corrected comments are enforced only by review, not by a gate.
