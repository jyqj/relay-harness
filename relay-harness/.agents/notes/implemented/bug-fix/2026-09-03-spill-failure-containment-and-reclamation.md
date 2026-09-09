# Agent Note: Spill failure containment and spill-storage reclamation

Status: implemented

English | [中文](2026-09-03-spill-failure-containment-and-reclamation.zh.md)

## Problem

Two defects in the spill family, one per side of the seam. In `subprocess-local`, a spill I/O failure — ENOSPC, EMFILE, or a temp cleaner removing the private spill directory — threw synchronously from `openSync`/`writeSync` inside a stream `'data'` callback, an uncaught exception that exits the whole harness process and, through the exit hook, force-kills every managed process tree. And the `SpillStore` seam had no deletion verb and no retention: `rlh-spill-*` spill files accumulated for the process lifetime, every restart orphaned the previous per-process root entirely, and the spill policy's own comment admitted "cleanup is deferred" with no deferral target — the [tool output spill note](../architecture/2026-07-08-tool-output-spill-files.md) listed the missing cleanup policy as deferred work.

## Decision

The subprocess collector contains the failure at its single call site: `OutputCollector.push` wraps the spill attempt so any spill I/O error calls `discardSpill()` (which already contains its own close/unlink failures) and lets the chunk continue into the in-memory tail — the documented lossy-tail degradation instead of a crashed process. A `spillFailed` flag folds into `readFrom`'s `lossy` flag, so readers observe that dropped head bytes have no spill file to recover them from even inside the retained window.

The seam gains the reclamation verb the retention story was missing: `SpillStore.disposeSession(sessionId)` reclaims every artifact owned by one session. The local backend implements it as a recursive delete of the session's `session-<hash>` directory and wires it to the `session/disposed` edge, so the backend — not each consumer — owns its storage lifecycle. Because locators are best-effort recovery paths rather than durable promises, reclaiming a disposed session's files is safe: a log that still references a reclaimed path reads it as a loud tool failure, the same shape a tmp clean or restart already produced. For residue that never sees a disposal — crashes, roots orphaned by restart — `spill-local` grows a validated `Config.orphanRetentionMs` field (positive integer, default 7 days) driving a one-shot bounded sweep at plugin load: roots matching `rlh-spill-*` under the OS temp dir whose mtime is older than the retention are removed, never the current process's own root, and anything unreadable or unlinkable stays for the next start.

## Alternatives considered

**Per-artifact `deleteSpill(ref)`.** Rejected for now: every current caller wants session-scoped reclamation, and per-artifact deletion invites consumers to reclaim files a forked sibling session's log may still reference.

**Wire reclamation in the spill policy.** Rejected because storage lifecycle is provider-specific behavior; a policy-owned listener would cover only policy-produced spills while `tool-fs-search` spills through the same backend, and each future backend would depend on some consumer remembering to clean up.

**Fail the stream when spilling fails.** Rejected: a stream `'data'` callback cannot throw safely, and dropping collection entirely loses even the diagnostic tail that still works.

## Consequences

A mid-stream spill failure degrades output to the bounded lossy tail with no process crash; `lossy` and `truncated` now also report the spill-degraded state, and `spillPath` is withheld exactly as for a failed final close. Disposed sessions reclaim their spill directories, and restarts no longer leak roots: the sweep removes expired ones at load. A session resumed in the same process after disposal finds its old spill paths gone — the tool read fails loudly and the model continues without the head, the accepted degradation. `SpillStore` subclasses must implement `disposeSession`; the seam's test stubs do so as no-ops.
