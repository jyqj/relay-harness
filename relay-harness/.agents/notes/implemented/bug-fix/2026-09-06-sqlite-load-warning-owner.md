# Agent Note: Synchronous SQLite load ownership

Status: implemented

English | [中文](2026-09-06-sqlite-load-warning-owner.zh.md)

## Problem

An eager SQLite import in a lease or journal adapter emits an experimental notice before the persistence adapter can apply its own initialization filter. CLI consumers observe unexpected stderr even when no database operation fails.

## Decision

The [SQLite runtime utility](../../../../packages/util/sqlite-runtime/README.md) owns one synchronous, cached builtin load. It intercepts only the exact SQLite stability notice during that call and restores the original warning emitter in a finally block. Adapters retain connection and transaction ownership.

## Verification

Cold subprocess tests create and query a real database, import the lease and journal owners, and check that unrelated experimental warnings and the same message with a different warning type remain visible. A failing builtin-load regression verifies delegation, restoration, and retryability. Assembled CLI and ACP snapshots retain their empty-stderr assertions.

## Alternatives considered

Process-wide warning suppression would hide unrelated diagnostics. Depending on a persistence adapter would invert utility ownership. Asynchronous filtering would leave a process-global interception active across unrelated work.

## Consequences

SQLite's experimental status is unchanged. The utility filters initialization noise, not database failures, and does not serialize database writes or take over adapter lifetimes.
