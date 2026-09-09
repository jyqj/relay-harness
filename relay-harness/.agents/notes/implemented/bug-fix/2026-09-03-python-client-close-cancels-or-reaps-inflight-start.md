# Agent Note: Python client close cancels or reaps an in-flight start

Status: implemented

English | [中文](2026-09-03-python-client-close-cancels-or-reaps-inflight-start.zh.md)

## Problem

`HarnessClient.start()` checked `self._closed` before acquiring the spawn lock, while `close()` set `_closed` and then snapshotted `self._proc` — both outside the lock that guards the process handle. When `close()` ran while a `start()` sat between its closed check and the lock, `close()` saw `_proc is None`, failed the waiters, and returned reporting a closed client; the interleaved `start()` then completed the spawn. The resulting runtime child received no shutdown request and no dispose ladder, so it lived until externally killed while the client reported closed. The TypeScript client cannot interleave this way — `closeTask` is memoized at entry and `start()` rejects once it exists — so the shared "close is terminal and reaps the child" contract held on only one SDK side.

## Decision

The closed check moved inside the spawn critical section: `start()` re-validates `_closed` under the same condition variable that guards the process handle, so a close that lands before the spawn cancels the start and no runtime child is created. `close()` settles against that critical section — it waits while a start is in flight — and then re-reads `_proc`: a spawn that completed before the settle is reaped by the normal shutdown ladder. A start already in flight therefore has one of two endings, matching the TypeScript memoized close task: cancelled before spawn, or completed and reaped. `_starting` is cleared in a `finally` with a broadcast, so a `start()` whose `Popen` raises also releases a waiting `close()` with `_proc` still `None`.

Both outcomes keep the existing semantics: close stays idempotent and terminal, a later `start()` raises `TransportClosedError`, and fail-waiter behavior is unchanged.

## Alternatives considered

**Keep the pre-lock closed check and only re-read `_proc` after the critical section.** Rejected because reading `_proc` outside the lock still races the assignment; only making both sides synchronize on the spawn critical section closes the window on both endings.

**Have `close()` hold the process-handle lock across the whole shutdown ladder.** Rejected because the ladder issues the `shutdown` request, whose request registration takes the same lock — holding it across the ladder deadlocks against the client's own request path and reader thread.

**Memoize a close task object like the TypeScript client.** Rejected as a larger restructure of the Python client's lifecycle state; the condition variable tied to the existing lock reproduces the same two endings with one flag and one wait.

## Consequences

A caller that races `close()` against `start()` can no longer end up with a live runtime child behind a closed client; both SDK sides now uphold the terminal-close-and-reap contract. The cost is that `close()` waits for an in-flight spawn's `Popen` to return — bounded by process creation, not by a turn — and the pre-lock portion of `start()` (launch-argument resolution, environment assembly) still runs before the cancellation point, so that work can execute uselessly on a closed client before raising. Two tests gate the endings: a close landing in the pre-spawn window cancels the start, and a close landing inside the spawn critical section waits for it and reaps the child.
