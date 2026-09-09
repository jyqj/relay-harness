# Agent Note: Route Code Index by canonical Session Workspace

Status: implemented

English | [中文](2026-08-29-code-index-workspace-routing-and-isolation.zh.md)

## Problem

The Web bundle mounted one `code-index-local` provider rooted at process cwd. Context preparation, model tools, and Code Index Center therefore had no durable way to select the Agent or Session Workspace, and a Client switching Sessions could receive status or candidates from the previously composed process-wide index. Workspace-hash filenames prevented accidental default-path collisions but did not make runtime ownership, request routing, eviction, or Remote scope explicit.

## Decision

The Code Index seam now exposes `forWorkspace(workspaceRoot)`, returning an immutable workspace-bound operation face. The explicit `code-index-local` provider canonicalizes and accepts only its configured root. The new `code-index-workspace-router` is the default Web/Desktop provider: canonical `realpath` is its registry key, each key owns one `LocalCodeIndexRuntime`, watcher, invalidator, SQLite file, epoch ledger, and embedding generation set, and every unscoped process-wide operation rejects.

Open entries are bounded by `maxOpenWorkspaces` and `idleEvictMs`. An operation holds a lease; LRU/idle eviction selects only quiescent entries, removes routing first, stops timers/watchers, awaits the embedding drain, closes SQLite, and makes a concurrent reopen await that close. Tool-result invalidation uses the emitting Session cwd. Database names use a 24-hex SHA-256 canonical-root suffix under the configured directory.

Code Context binds once with `StepContextInput.cwd` and uses the same face for candidate search and hydration. Every code-index model tool binds from `exec.agent.session.header.cwd`; the refresh busy set is workspace-keyed. Code Index Center Remote accepts `sessionId`, resolves the attached Host Session and its durable cwd, and never accepts a Client filesystem path. The Client status cache is Session-keyed and the Settings page subscribes to Session selection changes.

The single registered Cordis effect owns repeated-disposal suppression; the router’s disposed flag closes operation admission rather than acting as a second cleanup owner. Workspace cleanup failures are independent: one failing disposer must not keep other SQLite handles and watchers alive. Shutdown aggregates failures after all selected entries settle. Acquiring an entry and reserving its lease are separated by an asynchronous continuation. The router therefore verifies the published instance and shutdown state at reservation, retrying acquisition after a concurrent eviction. Finding an entry earlier does not authorize use after it leaves routing.

## Alternatives considered

- **Add `workspaceRoot` to every search/status/refresh payload** — rejected because it duplicates scope across the vocabulary and would let browser Clients submit filesystem roots; one immutable bound face makes cross-call hydration drift harder.
- **Keep one runtime and swap its root/database per request** — rejected because caches, watchers, in-flight refreshes, embedding drains, and epochs would become shared mutable state across Workspaces.
- **Open every Workspace for the Host lifetime** — rejected because watchers, SQLite handles, parser catalogs, and vector caches would grow with historical Workspace count.
- **Route from the most recently selected browser Workspace** — rejected because Agent steps, background tools, and multiple Clients need the durable Session cwd, not global UI state.

## Consequences

Two real Workspaces can index and search concurrently without sharing hits, chunk hydration, epochs, rebuilds, or databases. Session switches select a separately cached status and debug search. Evicted Workspaces reopen their durable derived generation rather than rebuilding solely because the process released resources. Headless deployments may keep the strict single-workspace adapter.

The router is process-local; multiple Host processes do not share its LRU leases. Exact SQLite operations remain synchronous inside each isolated runtime, and a removed Workspace cannot be newly canonicalized until it exists again.
