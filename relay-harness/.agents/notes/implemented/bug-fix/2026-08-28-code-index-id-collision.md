# Agent Note: Code-index occurrence IDs aligned to position hashing

Status: implemented

English | [中文](2026-08-28-code-index-id-collision.zh.md)

## Problem

Real-corpus indexing failed with `UNIQUE constraint failed: symbols.symbol_uid` (24 collisions across the parser package's own 32 source files): `symbolUid` is content-derived (`file + qname + kind [+ signature]`), so same-named local variables in different functions (`i`, `child`, `sym`) collide on the identical key. The reference implementation tolerates this only through upstream dedup at its write boundary.

## Decision

Two changes, both in the write path:

- `code-index-parser/src/id.ts` — `edgeId`/`refId` hash inputs now use the reference's byte-exact form (`kind:file:line_le32:col_le32`, `Buffer.writeUInt32LE`), so per-occurrence IDs distinguish same-content records at different positions. `symbolUid`/`chunkId` stay content-derived, matching the reference.
- `code-index-graph/src/store/writer.ts` — deterministic first-wins dedupe (`symbolId`, then `symbolUid`; `edgeId`; `literalId`) at the `graphRowsForOutcome` boundary, the same semantic as the reference's write-side ignore-on-duplicate. Input order is the priority; `buildGraphDelta` reports `duplicatesDropped`.

Existing v2 databases carry stale ID values (shapes unchanged); per the pre-release stance they are not migrated — `refresh({ forceRebuild: true })` rebuilds.

## Consequences

Parse-to-store indexing of a real corpus completes with zero UNIQUE violations (regression-smoke spec pins the corpus). Per-occurrence ID values changed for any database built before this fix.

## Alternatives considered

- **Migrate stored IDs in place** — rejected: the index is a derived medium with rebuild-on-mismatch; a force rebuild is cheaper and pre-release carries no compatibility promise.
- **Content-hash + occurrence counter IDs** — rejected: counter ordering depends on traversal order just as much as position does, while position matches the reference's key shape byte-for-byte.
