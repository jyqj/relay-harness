# @relay-harness/rlh-code-index-workspace-router

English | [中文](README.zh.md)

Multi-Workspace provider for `ctx.codeIndex`. It canonicalizes the workspace cwd selected by an Agent or Session, opens one `LocalCodeIndexRuntime` and one derived SQLite database for that identity, and returns an immutable workspace-bound operation face. The Web bundle uses this provider instead of binding the process working directory.

## Routing and isolation

Callers must use `await ctx.codeIndex.forWorkspace(session.header.cwd)`. Unscoped `status`, `search`, `hydrateChunks`, `refresh`, `reconcile`, and graph calls reject; the router never guesses from the last active Workspace. Canonical `realpath` identity collapses symlink aliases, while the SHA-256 workspace key gives every checkout a distinct database file and embedding generation ledger. Search hits, hydration identities, epochs, rebuilds, and maintenance status therefore stay inside the selected Session workspace.

`@relay-harness/rlh-code-index-local` remains the explicit single-workspace provider for headless deployments. Its `forWorkspace` adapter accepts only the configured canonical root.

## Lifecycle

The router lazily opens a workspace on its first operation. `maxOpenWorkspaces` bounds retained runtimes; quiescent entries are evicted least-recently-used, and `idleEvictMs` closes entries that remain unused. Active operations hold a lease. Eviction first removes the entry from routing, stops its invalidator and watcher, waits for the embedding drain, and only then closes SQLite. A concurrent reopen waits for that close before reusing the same database path.

Tool-result invalidation is routed by the emitting Session's cwd. Optional recursive watchers belong to their workspace entry and cannot schedule another entry's refresh.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `databaseDirectory` | RLH home index directory | Directory containing workspace-hash SQLite files |
| `maxOpenWorkspaces` | `4` | Maximum retained open workspace runtimes |
| `idleEvictMs` | `300000` | Idle lifetime before quiescent close |
| `watcherEnabled` | `false` | Start one recursive watcher per open workspace |
| `journalMode` | `wal` | SQLite journal mode for every workspace store |
| `exclude` | `[]` | Additional ignore patterns shared by workspace runtimes |
| `maxFileBytes` | `512000` | Per-file indexing byte ceiling |
| `debounceMs` | `500` | Per-workspace tool-result invalidation debounce |
| `dirtyPropagationMaxFiles` | `200` | Per-pass dirty-closure budget |
| `embedding` | disabled | Shared endpoint/generation configuration; vectors remain workspace-local |

## Model Experience

### No direct model request

#### What the model sees

Nothing directly. The Agent's `code-index-recall` contributor and `search_code_index` / `explore_code_graph` tools select the current Session cwd before search, so their existing ranked snippets, graph answers, status, and refresh results come only from that Workspace.

#### Token effect

No router-owned prompt tokens. Existing search, graph, and code-context output budgets apply after workspace routing.

#### KV Cache effect

No prompt-prefix change. Workspace identity is outside the prompt cache and each workspace retains independent index, embedding, and evidence epochs.

## Known Limitations and Deferred Work

- Exact SQLite scanning remains local and synchronous at the storage boundary; routing isolates stores but does not make one very large workspace cheaper.
- `maxOpenWorkspaces` is a process-local resource bound, not a distributed lease across multiple Relay Host processes.
- A removed workspace cannot be newly canonicalized; an already running operation completes against the identity it leased before removal.
