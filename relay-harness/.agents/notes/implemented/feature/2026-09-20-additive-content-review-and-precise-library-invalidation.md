# Agent Note: Additive content review and precise Library invalidation

Status: implemented

English | [中文](2026-09-20-additive-content-review-and-precise-library-invalidation.zh.md)

## Problem

Review was bound to a Session log prefix by explicit decision, so a user could not record what they actually inspected: which file bytes were read, and what checks ran over them. Separately, the Library invalidated every retained query on every `tool/result`, so one long-running session forced repeated full re-observation of the corpus.

## Decision

Add content review beside log-prefix confirmation, never on top of it. `work/reviewed` is a new log-only event carrying a user decision bound to explicit `WorkContentVersion` identities and `WorkCheckRecord` facts, with every reference resolving inside its own event. It names no prefix, reuses the receipt durability pattern (trusted request, maintenance serialization, flush plus physical re-read, identical resubmission reuse), and leaves `work/accepted`, `workAcceptance` and the confirmation policy untouched. The read side separates confirmed from current: `workResults/contentReview` reports `not-reverified` currency per confirmed digest, and a pure comparison upgrades it to `matches-confirmed` or `changed-unreviewed` only from an actual fresh observation. There is no file watcher and no re-verification promise.

Narrow Library invalidation to what the retained observation can no longer honestly serve: session created or disposed, a `tool/result` from a Session outside a query's observed corpus, or a `tool/result` that would actually change an observed inventory (new path or uncaptured success). Error results and already-known paths keep a still-valid page alive. Gaps stay reported and statistics still dedupe by source identity.

## Alternatives considered

**Reusing `work/accepted` with an optional payload.** One event would tempt clients to mix prefix confirmation with content claims and weaken the existing receipt invariant; a separate event keeps the by-design session-log semantics intact.

**Host-side re-hashing on read.** Making `contentReview` read device files would turn a passive read into a verification act and promise freshness the Host cannot guarantee between requests; the comparison stays a pure function callers apply to observations they already hold.

**Per-query invalidation instead of clearing all queries.** Queries share the epoch guard and eviction pool; invalidating only the touched query would keep stale pages reachable through other queries for the same changed corpus, for no measurable saving at the existing bounds (at most `maxLibraryQueries` observations).

## Consequences

`work/reviewed` joins the known event vocabulary, so logs written by this build refuse to load in builds that predate it (the repository's pre-release stance). Content reviews make the log grow like any other fact, and an approved digest proves nothing about the current file until someone re-reads it. Library pages now survive noisy sessions, but a session omitted from a full corpus observation (beyond `maxLibrarySessions`) invalidates on its first result — the precise rule is still conservative at the omission edge. The generated cordis-surface block for `docs/subsystems/work-results` was not regenerated here: the catalog generator cannot run against this worktree's stale built faces and currently fails on pre-existing unclassified types; the merge round owns that regeneration.

## Verification

Package tests cover durable persistence through the trusted HTTP endpoint, cold reads without activation, reference-resolution refusals, byte-identical resubmission reuse, the confirmed-vs-current currency states, and the invariant's unresolved-reference check; Library tests keep an error-result page valid, invalidate on a new contributing result, and retain gap reporting. `tsc -b` passes for the touched package. Regenerated persistence catalog and re-recorded bilingual digests are part of the change.
