# Agent Note: Persistence write-path teardown — one composite effect, an admission fence, and a retried retirement

Status: implemented

English | [中文](2026-09-03-persistence-write-path-teardown-ordering.zh.md)

## Problem

The persistence coordinator's dispose contract is "event admission closes before the final drain reaches quiescence and closes the backend", but the implementation did not own that ordering. The drain effect and the four `session/*` listeners were separate top-level effects on one fiber, and Cordis disposes a fiber's separate effects in parallel (`Fiber._unload` maps every disposable through `Promise.all`), so registration order guarantees nothing at that level. Admission closed before the drain only because every disposer happened to be synchronous and the microtask queue happened to run the listener removals before the drain's first backend write. Any future async disposer in the group would reopen a silent lost-batch window: an event enqueued mid-drain lands in a write-behind batch that can only ever be written after `backend.close()`.

The same teardown had a second stuck state. A retirement whose final flush failed was warned about and forgotten: the retirement record was deleted while the lifecycle's live entry and retained batch stayed behind, so the buffered events could never drain and the session id could never be reused — a later same-id create was rejected with a misleading "already bound to a different live session" collision.

## Decision

**One composite effect owns the whole write path.** The drain disposer and the four `session/created` / `session/event` / `session/flush` / `session/disposed` listeners are collected inside a single generator effect. Within one effect, Cordis tears the collected disposables down as one serial chain in reverse collection order, so the drain disposer is yielded first, collected first, and therefore runs last: listener removal deterministically precedes the drain regardless of what else shares the fiber. The drain body sets `tearingDown` as its first statement, and the `session/event` listener treats that flag as admission-closed — a listener that somehow evades removal queues nothing, because a batch admitted after the drain began could only be written after `backend.close()`.

**A failed retirement drains again — once — and always releases.** The first drain failure records the error, keeps the retirement record pending (so same-id reads wait for the outcome), and arms one backoff retry (`retirementRetryDelayMs`, default one second, validated when a backend supplies it). The retry succeeding releases the lifecycle normally. The retry failing releases anyway: a permanently failing backend cannot hold the id hostage, and the failure is already reported at retirement, so the dispose drain must not raise it a second time. `retireWithRetry` therefore always fulfills; the failure surfaces through the log and the recorded-failure map, never as an unobserved rejection. While a failure is recorded and the stranded controller still holds work, a same-id create rejects with that underlying write failure instead of the collision text; once the retry drains or exhausts, the id is reusable (adoption over the persisted log, or a fresh create when nothing was persisted). During dispose the armed retry timers are cleared — the drain flushes the same stranded session itself and owns the final report.

## Consequences

The admission-before-drain invariant no longer depends on microtask scheduling: the composite serial chain removes the listeners even when a sibling disposer awaits a real macrotask, and the `tearingDown` fence covers the pathological out-of-order case. A dispose-ordering test locks the listener-free state at the drain's first backend write next to a sibling effect whose disposer removes its own listener a macrotask late. Retirement outcomes are trichotomous and each is pinned by test: transient failure retried into a clean release and id reuse, permanent failure released with a single report (dispose stays clean), and the stranded window rejecting a recreate with the underlying write failure.

What this costs: a failed retirement now delays its id's availability by one retry delay (bounded by `retirementRetryDelayMs`), and when both attempts fail the retained events are lost — they were already unwritable, so the alternative was holding the id forever. A retirement whose retry timer is cleared by a concurrent dispose leaves its retirement promise pending for the remaining process lifetime, which nothing can observe past teardown.

## Alternatives considered

- **Keep separate effects and rely on registration order** — the current code's ordering was real but accidental: it holds only while every disposer in the group stays synchronous, which is exactly the property a plugin ecosystem cannot promise.
- **Await the stranded flush inside the create-collision branch** — deadlocks: `onCreated` runs inside the per-id serialize chain, and the stranded controller's write re-enters that same chain, so the recovery flush waits on the caller that is waiting for it. The retry runs its flush outside the chain, which is why recovery lives there.
- **Retry until success** — an unbounded retry turns one dead backend into a permanent per-id hot loop; a single backoff retry bounds the work while still covering the transient-failure case the stranding was blamed on.
- **Keep the retirement rejection as the waiters' error** — propagating the first failure to `prepare`/`load` waiters made the id unusable on a transient error; waiters now wait through the retry and observe storage after release.
