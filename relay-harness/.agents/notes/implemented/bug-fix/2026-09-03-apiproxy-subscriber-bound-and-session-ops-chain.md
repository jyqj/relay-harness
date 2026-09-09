# Agent Note: Apiproxy subscriber buffer bound and per-session operation chain

Status: implemented

English | [中文](2026-09-03-apiproxy-subscriber-bound-and-session-ops-chain.zh.md)

## Problem

Three gaps shared one root: the API gateway admitted work without proving the state it checked still held, or without bounding what a consumer could make it retain.

An `events.mux` subscriber's `FrameQueue` buffered every session event with no cap. A connected-but-stalled consumer — a suspended proxy, a TCP zero window — never aborts and never pulls, so the queue grew without bound for the stream's lifetime while the dead queue also stayed registered in the fan-out set, retaining every future event. Host memory was the attacker's lever.

The `agentPreset.select` blank-session guard was a time-of-check-to-time-of-use race. The guard ran at the head of the swap, but `recompose` is a slow asynchronous step; a `session.prompt` arriving in that window opened the turn under the OLD composition and the switch then committed on top of it — the exact transcript state (user message before the `agent-preset/selected` marker) the guard exists to prevent. Prompt admission and model selection ran outside any chain the swap participated in.

The cold-list blank probe checked the artifact's physical size against `coldBlankProbeMaxBytes`, then read the whole stored log. Between the stat and the read, a session could attach and start growing; the read side had no bound, so the configured ceiling could be bypassed entirely. (The threshold is checked before `readFrom()` rather than enforced by persistence — the [bounded blank-verification decision](2026-08-13-bounded-cold-blank-verification.md) accepted advisory status for the size gate; this change closes the most common growth source without adding persistence atomicity.)

## Decision

**`FrameQueue` gains a byte budget.** Each queue is constructed with `maxBytes` (config `muxStreamBufferBytes`, default 8 MiB, validated `z.natural()`), and `push` measures the frame with `JSON.stringify` — the serialization the SSE layer performs immediately afterward, so it is the honest measure of the retained value. A push that puts the retained total over the budget ends the queue: the crossing frame is still delivered, then the stream closes cleanly. The queue never drops or truncates individual frames — a silently dropped delta would corrupt the client's incremental fold. Termination is safe by the existing client contract: the shipped pump treats a closed event stream as reconnect-and-rebaseline, and the mux reopens replay the subscription baseline, pending questions and approvals with stable rpcIds, queue snapshots, and jobs baselines. Drain switched from `buffer.shift()` (O(n) per frame) to a head cursor with buffer release at exhaustion, so a long-lived subscriber costs nothing when idle.

**One per-session operation chain.** `presetSwitches` (per-session selects) and `imageAdmissionChains` (per-agent image admission and model selection) collapse into one `sessionOperations` chain keyed by SessionId. `session.prompt` admission in every mode, `session.selectModel`, and `agentPreset.select` all run their state checks and commits inside that session's slot, so the blank guard is authoritative again: a prompt cannot slip into the recompose await. A belt-and-braces re-check after `recompose` (blank AND idle) refuses with `agent-preset-locked` if any out-of-chain admission — direct Agent entry — started a conversation anyway.

**The cold probe re-checks attachment immediately before `readFrom`.** `summarizeCold` takes an `isAttached(id)` predicate (the gateway passes its live-session lookup). An attach that lands during the stat makes the probe skip the read; the row is served from the live session as before.

## Alternatives considered

**Drop or truncate frames at overflow.** Rejected: a dropped assistant delta silently desynchronizes the client's message fold; a clean stream end with full baseline replay loses nothing.

**Apply backpressure via `desiredSize` in the SSE layer.** Rejected: the exposure is the retained queue, not the wire; a stalled consumer never reads `desiredSize` either. Bounding retention is the only check the attacker cannot route around.

**Re-check blankness only (keep two chains).** Rejected: the same prompt mid-recompose race reaches `session.prompt` through every mode, and `selectModel` participates in the same admission ordering; separate chains would re-open the interleaving the checks sit inside.

**Make the size gate atomic with the read (persistence-level bound).** Deferred, matching the bounded-verification note: it needs a persistence operation and a backend contract for one probe optimization. The attached re-check removes the realistic in-process growth source; an external process appending to a cold artifact within the same millisecond window remains an accepted advisory gap, and the read remains bounded by whatever the artifact actually grew to only in that residual window.

## Consequences

A stalled or slow SSE subscriber is now disconnected with a clean stream end instead of growing host memory; worst case is one reconnect cycle for a genuinely slow-but-alive consumer, tunable per deployment through `muxStreamBufferBytes`. A prompt submitted while a preset swap is mid-recompose now waits behind the swap (and runs under the NEW composition) instead of interleaving; a swap that observes a started conversation refuses with the existing `agent-preset-locked` code. A cold probe whose session attached during the stat reads nothing. Text prompts are now serialized per session — previously two concurrent text admissions could interleave their appends; ordering is now the queue's arrival order. No wire fields, event schemas, or snapshots change: the affected transcripts differ only in event ORDER for the raced scenarios that previously produced the undefined interleaving. The served-web seeded-session e2e failure first attributed to this chain was later exonerated by wire instrumentation — the switch path never enters the slot — and the admission ordering is pinned by `settles a prompt queued behind a slow swap with the swap committed first`; the [misattribution note](../testing/2026-09-03-seeded-session-switch-e2e-misattribution.md) owns the corrected attribution and the residual client-side flake.
