# Agent Note: Terminal-record retention in the local job registry

Status: implemented

English | [中文](2026-09-03-jobs-terminal-record-retention.zh.md)

## Problem

`LocalJobRegistry` never deleted a terminal record. Only owner-scope disposal and service teardown removed rows, so an unowned job had no deletion path at all: every settlement kept its record for the process lifetime, and the model-facing `list()` — plus the visible-set each `onJobsChanged` consumer re-read — grew without bound on long-lived agents.

## Decision

The registry now bounds terminal-record retention with two validated `Config` fields: `terminalRetentionMs` (positive safe integer, default `60000`) and `maxTerminalRecords` (positive safe integer, default `100`). A terminal record is prunable only once it is reported — its completion notice deliverable — and its grace has elapsed; beyond the per-bucket cap the oldest-finished reported records are dropped. Sweeps run at `start()` and `list()` time, never on a timer, and each affected owner's visible-set change is announced like owner-disposal removal.

Retention never drops an unreported terminal record, so completion notices remain at-least-once. A pruned id reads as `unknown job <id>` from every access path — the existing fail-loud behavior, no new code.

## Alternatives considered

**Cap by record count alone.** Rejected because a low cap could evict a settled job before any reporter delivered its notice; the reported gate, not the cap, protects delivery.

**Prune on settlement.** Rejected because a notice reporter legitimately re-reads the record right after settlement; sweeping only at entry points (`start()`, `list()`) keeps the settling read path untouched.

**A background sweep timer.** Rejected because both entry points already traverse the store, so an idle-registry timer adds lifecycle surface without removing any retention delay that matters.

## Consequences

A caller reading a job after terminal + reported + grace — or beyond its bucket cap — now gets `unknown job <id>` instead of a stale snapshot, and job lists shrink as records age out. `job_output` of a pruned id fails loud with the same message it already used for never-existing ids. Legitimate workflows that read a job within the default 60-second window, or that keep a job reported through `read`/`wait`/`kill`, see no change. Unbounded growth now requires records that never become reported, which the waiters path already bounds.
