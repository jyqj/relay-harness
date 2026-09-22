# Agent Note: Bounded job stop and the control-lost-unknown record

Status: implemented

English | [中文](2026-09-20-bounded-job-stop-and-control-lost-unknown.zh.md)

## Problem

`LocalJobRegistry` awaited `job.settled` unboundedly after every teardown cancel, and `kill()` left a stop requested forever. A producer whose `cancel` returned without ever settling `JobHooks.done` was indistinguishable from a slow stop: its record stayed `stopping`, held one admission slot for the rest of the service lifetime, and stalled owner disposal and service disposal indefinitely. The only detectable failure was a cancel that threw. Readers also had no honest way to see "stop requested, outcome unknown" — every closed status claimed a producer-confirmed terminal.

## Decision

The stop path is bounded and honest about what the registry knows.

- **Bounded stop protocol.** Every stop request — `kill()` or a teardown cancel — arms a per-job watch. After the stop grace (`Config.stopGraceMs`, default `5000`, or the per-job `JobStart.stopGraceMs` override) without `done` settlement, the registry escalates to the producer's optional `JobHooks.terminate` hook for one more grace, then closes the record as `control-lost-unknown`. Settlement at any point clears the watch, so compliant producers never pay the bound.
- **`control-lost-unknown` is a closed, unconfirmed status.** It joins `JobStatus` and carries `finishedAt` (when the bounded stop gave up) like the terminal statuses, and it releases waiters and notifies listeners exactly once under the same first-wins commit as a settlement — but it never claims the work stopped. A producer that settles late only logs; the record stays immutable. `JobRegistry`'s settlement vocabulary gains no producer-facing outcome: `JobOutcome` still enumerates only what a producer can confirm.
- **Teardown never hangs.** `disposeOwned` and `disposeAll` still await `settled`, but the watches close every unconfirmed record within two windows, so teardown completes without producer cooperation. The existing force-fail on a throwing cancel is unchanged.
- **Capacity is constrained, not silently released.** A `control-lost-unknown` record keeps counting against `maxConcurrentJobsPerOwner` — its work may still be running — and retention pruning never drops it. At most `Config.maxUnconfirmedJobsPerOwner` (default `5`) accumulate per bucket; beyond the cap the reconciliation drops the oldest-finished unknown record, warns, and publishes the removal, so the capacity release is explicit and the pruned id reads as `unknown job <id>`.
- **The state is visible end to end.** The apiproxy wire view (`JobView`) and its zod schema carry `control-lost-unknown`, and the jobs panel renders a dedicated label ("stop unconfirmed, outcome unknown") with the attention dot, distinct from `killed`. `rlh-tool-jobs` renders the status verbatim, so model-facing notices show the unknown state without changes.

## Alternatives considered

- **Await settlement unboundedly and rely on producers to be correct (status quo).** Lost: one misbehaving producer froze its owner's disposal and permanently leaked an admission slot; the defect comment itself acknowledged the stall.
- **Fake a terminal `killed` when the bound elapses.** Rejected because it lies about the one fact the record exists to carry: the producer never confirmed anything, and downstream notice/report paths would treat unknown-outcome work as cleanly stopped.
- **Refuse new jobs once unknown records reach a cap.** Rejected for this provider: an owner that hit the cap could never start work again until restart. Dropping the oldest unknown record keeps the bucket usable while making the release loud and explicit.
- **Make the stop bound derive from `wait()` timeouts or per-call arguments.** Rejected because stopping is a lifecycle policy of the registry and owner, not of one caller; a config default with a per-job `JobStart.stopGraceMs` override keeps the decision at the composition that owns the producer.

## Consequences

Bought: owner and service disposal complete without producer cooperation; unknown-outcome work is visible as a distinct status in registry snapshots, the wire view, and the UI; capacity held by unknown records is bounded and released only through an explicit, warned reconciliation; the `rlh-jobs` snapshot invariant now ties `finishedAt` to the closed-status set (three terminals plus `control-lost-unknown`).

Cost: two new provider config fields (`stopGraceMs`, `maxUnconfirmedJobsPerOwner`) and one optional producer hook (`JobHooks.terminate`) that existing producers do not implement — without it the bound is one window instead of two; a dropped-by-reconciliation record's work remains untracked by design, so the warning is the only trace; and a late producer settlement after `control-lost-unknown` is logged, not recorded.

The `rlh-jobs-local` registry suite covers the normal kill, the no-terminate and terminate-then-settle and terminate-ignored escalations, late settlement, teardown of owner and service without settlement, capacity retention, and cap reconciliation; the apiproxy suite pins the wire frame ordering `running → stopping → control-lost-unknown` and its distinctness from `killed`.
