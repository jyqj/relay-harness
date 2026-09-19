# @relay-harness/rlh-jobs-local

English | [中文](README.zh.md)

Process-local implementation of the [`@relay-harness/rlh-jobs`](../jobs/README.md) registry contract: `LocalJobRegistry` keeps every record in memory, issues per-kind `<kind>-N` ids, and hands out fresh snapshots, never live state. Load it as a plugin and it registers as `ctx.jobs`.

## Admission

`maxConcurrentJobsPerOwner` is a positive safe integer and defaults to `10`. Before invoking a producer, `start()` counts the exact owner's `running`, `stopping`, and `control-lost-unknown` records; all unowned jobs share one separate service bucket. Terminal history does not occupy capacity. Only producer `done` settlement releases a stopping job's place; a `control-lost-unknown` record keeps its place, because its work may still be running, and only the unconfirmed-cap reconciliation releases it explicitly.

At capacity, `start()` fails before producer execution and id allocation with an error that names the limit and tells the model to use `job_kill`, wait for the job to finish stopping, and retry. The registry does not queue, preempt, or maintain a second mutable counter.

## Lifecycle

Jobs belong to their owner and backend, not the producer tool fiber, so producer and controller reloads do not stop them. The first job for an owner attaches one awaited effect to the exact `Agent` scope. Owner disposal cancels that object's jobs, awaits producer quiescence, and removes their snapshots; reused agent or session ids cannot redirect an old cleanup.

Service disposal closes listeners, cancels all live jobs, awaits their records for at most the bounded stop window, and detaches effects from surviving owner scopes. If teardown cancellation throws, the service force-fails the record and warns that work may be orphaned instead of deadlocking.

Every stop request — `kill()` or a teardown cancel — arms a bounded watch. After `stopGraceMs` (default `5000`; per-job `JobStart.stopGraceMs` overrides it) without producer settlement, the registry escalates to the producer's optional `JobHooks.terminate` hook for one more window, and then closes the record as `control-lost-unknown` instead of a producer-confirmed terminal: the stop was requested, but the outcome of the work stays unknown. A producer that settles later only logs; first-wins keeps the unknown record immutable. Teardown therefore waits at most two windows per job and never hangs on a producer that ignores cancellation.

An unknown record keeps occupying admission capacity and is never retention-pruned. At most `maxUnconfirmedJobsPerOwner` (default `5`) accumulate per bucket; beyond the cap, the reconciliation drops the oldest-finished unknown record — releasing its capacity explicitly, with a warning — and the pruned id reads as `unknown job <id>`.

Settlement is first-wins: the earliest terminal outcome — producer settlement, a rejected `done` contained as `failed`, or a teardown force-failure — records once, releases waiters, and notifies listeners once with per-listener containment. Pending waits mark the job reported before listeners run so completion reporters do not duplicate notices, and a teardown cancel marks it for the same reason: nothing will read a notice addressed to an owner being destroyed. Completion is the last thing a settlement announces, after the record is committed and the visible-set change is published, because a reporter may open a model turn synchronously and every other observer must already have seen the settled record.

Controllers and listeners are layered by the scope that registered them, in the tools-registry shape: a registration files into its registering context's scope, and a read unions the global layer with the owner's scope chain. One process-wide registry therefore answers per-owner questions per owner — `start()` refuses `background jobs unavailable: no job controller serves this agent (load @relay-harness/rlh-tool-jobs in its composition)` for an owner whose own composition attaches none, however many other compositions attach theirs, and a settlement reaches only the listeners its owner's composition registered.

Terminal records are not kept forever. A record stays readable until it is reported — its completion notice deliverable — plus `terminalRetentionMs` of grace (default `60000`), and each owner bucket keeps at most `maxTerminalRecords` terminal records (default `100`), oldest-finished first. Retention sweeps run at `start()` and `list()` time, never on a timer; an unreported terminal record is never pruned, so completion notices stay at-least-once. A pruned id reads as `unknown job <id>` from `get`, `read`, `kill`, and `wait`.

## Model Experience

Indirectly, through producer plugins and [`rlh-tool-jobs`](../tool-jobs/README.md), which render job ids, output, status, cancellation, and completion notices.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Jobs are process-local** — records die with the harness process; durable or cross-restart execution needs a separate backend implementing the seam.
- **`control-lost-unknown` work is unmanaged, not stopped** — a producer that ignores both `cancel` and `terminate` keeps running resources past the bounded stop window; the registry only bounds its bookkeeping, releases the record's capacity explicitly at the unconfirmed cap, and cannot reclaim the work itself.
