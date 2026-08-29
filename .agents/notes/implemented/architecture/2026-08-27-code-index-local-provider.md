# Agent Note: Local code-index provider — four layers folded behind one seam

Status: implemented

English | [中文](2026-08-27-code-index-local-provider.zh.md)

## Problem

The local code-index capability had a Service Definition (`ctx.codeIndex`), a ranking engine, and a derived SQLite store, but no Service Provider: nothing walked a workspace, decided what changed, chunked accepted files, or wired storage to retrieval. Each of those layers belongs somewhere specific, and until they assembled into one provider the tools shipped in `tool-code-index` could never answer.

## Decision

Open `@relay-harness/rlh-code-index-local` with the provider plugin (`CodeIndexLocal extends CodeIndex`) plus per-layer modules that keep each concern independently testable:

- **Scanner** transcribes the reference implementation's default hard-exclude (15) and include (27) glob arrays verbatim, stacks them under three-layer exclusion union (hard ∪ config ∪ parsed root `.gitignore`), prunes directories before descending, counts directory symlinks it refuses to traverse, and yields one batch per contributing directory.
- **Diff** keeps two stages apart: `planSnapshotDiff` decides on stored mtime+size only; `confirmChangedByHash` re-reads candidates once so touch false positives and mtime jitter stay Unchanged. A candidate deleted mid-pass falls into the same delta's removal half, injected-io suites pinning every race branch deterministically.
- **Chunker** applies the 80-line budget from the reference implementation's `default_chunk_line_budget`, stamps `generic`/0.5 parser vocabulary, gates binary payloads via fatal UTF-8 decoding, and keeps oversized files as row-without-chunks entries whose summary/excerpt still come from the first window.
- **Provider runtime** owns folding (one in-flight pass shared by concurrent refresh/lazy callers), tier-resolved cache/port/engine rebinding after commits, epoch injection at answer time, and rebuild-by-deletion for `forceRebuild`. Tool-result invalidation debounces into that fold; the opt-in recursive watcher is latency-only and degrades loudly-but-survivably through `status().degraded`.

The store path defaults to `<rlhHome>/index/code-index-<hash12>.sqlite3`, hashing the workspace real path so multi-checkout deployments cannot clobber each other — explicitly an interim shape ahead of the planned configurable storage-root layout. A `last_refresh` metadata ledger key persists the committed summary so restarts can report freshness without re-walking.

Real composition boots the provider, both prerequisite services, and the tool consumer from a test-only cordis.yml through the actual Loader, then edits and deletes fixture files on disk before flushing deterministically through a test-only `refreshInternal()` hook: decoys inside gitignored trees never appear, new content ranks immediately, the deleted file vanishes, and epochs advanced exactly once more than before.

## Consequences

This closes Phase 1's chain of siblings ([the seam scaffold](2026-08-27-local-code-index-seam.md), [storage writes/reads](2026-08-27-code-index-sqlite-writes-reads.md), [the tool consumer](2026-08-27-code-index-tools.md)): every role of the capability now has an owner wired into one composition.

Coverage discipline forced real behavioral seams: mocking `node:fs` makes whole-file executions invisible to v8 instrumentation, so runtime-behavior suites live in mock-free spec files while the mocked file pins only construction-time rejection paths; the injected `RefreshPassIo` pair exists because genuine scan→read deletion races cannot be staged against a live filesystem. One justified `/* v8 ignore next */` covers the detached stale-pass rejection sink, which timers dispatch outside any awaiting caller.

Registration gaps stayed open deliberately: the generated catalog's six-point checklist for the new `ctx.codeIndex`-implementing package and the group README index belong to the consolidating main session, as does tsconfig.host.json aggregate wiring.

## Alternatives considered

- **Per-tool eager refresh guarded by locks instead of folding** — rejected: the tool layer already fails fast with `INDEX_TOOL_REFRESH_IN_PROGRESS` "instead of queueing behind the fold", so the seam contract names folding as the owner semantics; a lock would duplicate it below the fold point.
- **Path-level invalidation keyed on tool arguments** — rejected: trusting every tool's reporting to name touched paths buys almost nothing over the mtime+size fast path and turns one honest tool into silent staleness.
- **Watcher as correctness source** — rejected outright by the seam note: events are hints; the walk is authoritative, so watcher refusal downgrades rather than fails composition.
