# Agent Note: SQLite live-observation cache and storage-medium ownership

Status: implemented

English | [中文](2026-09-03-sqlite-live-observation-cache-and-medium-ownership.zh.md)

## Problem

Two SQLite owners lacked the guards their siblings have. `SqliteSessionQueryEngine` re-fingerprinted every live session's entire log on every search — a `structuredClone` of the header and each event, a full JSON serialization, and a SHA-256 — so two consecutive searches over an unchanged corpus paid the corpus's byte cost twice. And `storage-sqlite` opened any SQLite file whose `user_version` was 0 or 1: it created its unit tables next to a foreign application's tables and stamped the file, silently co-writing a medium it did not own, where `session-persistence-sqlite` and `session-query-sqlite` both refuse foreign content before any write.

## Decision

The search engine caches one observation per live session id, validated by an exact change marker: `Session.events` reuses one deep-frozen array between appends, so array-reference equality plus `sameHeader` proves the log is byte-identical and the cached documents and fingerprint are reused; an append gives that session a new snapshot array and only it is re-fingerprinted. The observation path no longer clones its inputs — live inputs are the store's frozen snapshots and persisted inputs are arrays materialized privately by one `inspect()` call, both read-only — so the fingerprint stays byte-identical to the cloned form. Cached entries are dropped when a session leaves the live set during reconciliation. No `Config` field: this is an implementation-internal cache with unchanged results, not a deployment choice.

`storage-sqlite` now stamps `PRAGMA application_id` (`STORAGE_SQLITE_APPLICATION_ID = 0x44534852`, next in the reserved Relay Harness sequence) alongside `user_version`, and refuses before any write: another application's id, an unstamped file that already holds user tables, or a file stamped as this backend without the `units`/`unit_globals` metadata tables (or carrying unrecognized tables) fails with the new `StorageErrorCode` `foreign-medium`; a wrong layout version still fails `version-mismatch`. The journal-mode pragma and DDL run only after these checks, mirroring the two session backends' open order. Only a zero-version empty database is adopted.

## Alternatives considered

**A seq-watermark protocol for live change detection.** Rejected because the snapshot-array reference equality is exact and free; a watermark protocol adds state to re-derive what the store already guarantees.

**Adopt foreign databases after table-name inspection.** Rejected because co-writing and stamping a foreign medium is the defect; name checks would only narrow which strangers get overwritten.

**Keep the `structuredClone` as cheap safety.** Rejected because it re-copied every event of every live log per search while the inputs are already frozen or call-private; a defensive copy against the store's own published snapshots contradicts the single-read-path rule.

## Consequences

Repeated searches over an unchanged corpus skip live re-fingerprinting entirely, and fingerprint values are unchanged, so generations, cursors, and indexed content behave identically. `storage-sqlite` refuses media created by earlier builds (unstamped but populated) instead of adopting them; per the pre-release stance those databases must be recreated rather than migrated. The former mid-materialization obstruction test became unreachable — an unstamped medium with any foreign table is now refused before materialization — so recovery-after-refusal is pinned instead by removing the foreign table and reopening.
