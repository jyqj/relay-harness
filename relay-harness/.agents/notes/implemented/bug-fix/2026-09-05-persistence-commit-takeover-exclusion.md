# Agent Note: Exclude lease takeover through complete persistence commits

Status: implemented

English | [中文](2026-09-05-persistence-commit-takeover-exclusion.zh.md)

## Problem

A fence checked before calling a storage backend does not serialize lease takeover with that backend's asynchronous open, write, or fsync. The lease row and session data live in separate stores. An old owner can enter storage while current, expire during I/O, and complete a write after a successor acquires the lease. Cold resume also repairs history before live setup installs a Session fence, so protecting only live appends leaves recovery outside the exclusion protocol.

## Decision

The [Activation lease store](../../../../packages/subagent/subagent/src/activation-lease.ts) acquires a child-specific SQLite `BEGIN IMMEDIATE` lock for every ownership acquisition, release, and full persistence mutation. Mutation locks use independent connections and files below the canonical lease-database path, with child ids hashed into filenames. Existing lock directories and files are checked with `lstat`; symlinks, dangling links, non-regular files, and multiply linked lock files reject before SQLite opens them. A lock remains held until the complete asynchronous mutation settles. The main lease database keeps its short token/fence transactions and independent renewal; it is never held open as a transaction across backend awaits. Same-child reentrant admission and foreign contention fail closed with `LEASE_HELD`, without synchronously waiting for the event loop that must finish the current mutation. Different children retain independent mutation locks.

`SessionPersistenceFence.runExclusive()` carries this exclusion through the [shared persistence mutation helper](../../../../packages/session/session-persistence/src/mutation.ts). The coordinator retains the exact proof for queued writes and retirement, rechecks ownership after lock admission, and awaits the complete backend append or repair before releasing the lock. A mutation admitted while current may finish after expiry, but a successor cannot acquire until that commit has settled. Subsequent old-owner mutations reject. External tool bodies use final admission guards only; their already-started external effects are not rolled back or serialized by the storage lock.

`ResumeAgentOptions.persistenceFence` passes the same proof through the [agent factory](../../../../packages/core/agent-loop/src/index.ts) to `SessionPersistence.prepare(id, signal?, fence?)`. Cold commit and its revision check run under that proof before setup. Preparation does not install a second Session registration: the continuation manager installs the same proof exactly once during unpublished live setup. A cancelled caller cannot release a storage lock while its already-started backend mutation is still running.

Lease clocks and lifetimes are validated before mutation. Renewal rejects zero or negative lifetimes just like acquisition; a rejected renewal cannot expire the existing owner. Fault-injection regressions replace the lock directory during creation and reject lock-file open or permission changes, then prove that a clean retry still acquires the first fence.

## Alternatives considered

- Hold the main lease-database transaction across backend I/O: renewal and same-process acquisition can reenter or block the event loop while the original mutation needs it to finish. Independent child locks avoid that coupling.
- Share one global mutation lock: unrelated children would reject or wait behind each other's persistence latency. Per-child locks retain independent progress.
- Use a stale-timeout lockfile: deleting a supposedly stale lock can admit a second owner while the original process is paused. SQLite connection locks are released by the OS on process death and are never reclaimed by unlinking an active inode.
- Keep only pre-dispatch assertions: they protect queued work but do not serialize the complete backend commit with takeover.

## Consequences

The [lease tests](../../../../packages/subagent/subagent/tests/activation-lease.spec.ts) cover renewal during mutation, exclusion beyond expiry, failure, nested admission, stale ownership, and store closure. The [cross-process tests](../../../../packages/subagent/subagent/tests/persistence-takeover.spec.ts) use real JSONL and SQLite commits plus independent Node owners: takeover is rejected while I/O is paused, succeeds after the durable commit, and succeeds after a lock-holding process is killed. The [persistence tests](../../../../packages/session/session-persistence/tests/persistence.spec.ts) pin cold recovery inside the supplied proof; the [resume tests](../../../../packages/core/agent-loop/tests/resume.spec.ts) pin exact-proof forwarding before setup.

Lock files are persistent coordination identities, proportional to durable child ids rather than active writers. The runtime closes handles after settlement but never unlinks lock files. Retention can remove them only after all hosts capable of opening those identities are stopped; deleting a live pathname could split one lock into two inodes. Closing a lease store refuses new admission and defers its final handle closure until existing mutations settle. A hung but live backend intentionally continues to exclude takeover; abandoning its promise would break the storage guarantee. Deployments without an exclusion-capable proof retain pre-dispatch checks only. Writers bypassing the shared proof protocol are outside this exclusion guarantee.
