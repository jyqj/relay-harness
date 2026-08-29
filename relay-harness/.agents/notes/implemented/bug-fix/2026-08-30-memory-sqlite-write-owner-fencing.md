# Agent Note: Fence every canonical memory write by current ownership

Status: implemented

English | [中文](2026-08-30-memory-sqlite-write-owner-fencing.zh.md)

## Problem

The canonical Memory SQLite store permits several mutation families: governed revisions, prepared-turn settlement, access accounting, outcome reconciliation, and extraction queue admission and lease settlement. Repeating `BEGIN IMMEDIATE` / heartbeat refresh / commit logic in each family permits an idempotent early return to commit without checking current ownership. Refreshing ownership after data statements remains rollback-safe but lets the fencing rule depend on every branch reaching the final statement. Same-process sibling handles also share one process identity, so any sibling deleting the heartbeat at close can strand the handles that remain live.

## Decision

`SqliteLongTermMemory` routes every synchronous canonical-store mutation through one `withOwnedWrite` operation. It opens `BEGIN IMMEDIATE`, refreshes the pid/boot-id owner row before the first domain mutation, runs the operation, and commits; any ownership or operation failure rolls the transaction back. Signal inserts receive the admitted transaction handle instead of discovering a connection independently. Prepared-turn commit/abort and extraction fail validation read their current row inside that transaction, and extraction failure checks the lease deadline in its settlement update.

The process claim is reference-counted by canonical database path. Same-process sibling providers may share the process owner, while only the last clean close conditionally deletes its owner row. An ownership-CAS failure has a distinct `MemoryStoreOwnershipError`; access accounting remains fail-open for ordinary storage failures but propagates this error so a superseded provider cannot keep performing read-triggered writes.

## Alternatives considered

- **Refresh after each operation's data statements** — rejected because rollback protects the database but an idempotent or empty branch can bypass the refresh and commit without proving ownership.
- **Give every provider instance a different owner identity** — rejected because the store's promise is one process per path and same-process sibling handles are useful for connection-level concurrency checks.
- **Run a background heartbeat** — rejected because ownership matters when a write occurs; transaction-local fencing is sufficient and does not keep an idle process authoritative indefinitely.

## Consequences

Every write family has one settlement structure and fails before mutation when another live process owns the store. A long-idle process can still be superseded after `ownerStaleMs`; its next write fails loudly. Tests replace the owner heartbeat and cover prepared-turn prepare/commit/abort, search accounting, new and idempotent enqueue, expired-terminal claim, complete, fail, and governed entry writes, then verify every domain row is unchanged. A separate two-connection case closes one sibling and proves the remaining sibling can still enqueue.
