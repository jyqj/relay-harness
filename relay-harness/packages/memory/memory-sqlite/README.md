# `@relay-harness/rlh-memory-sqlite`

English | [中文](README.zh.md)

Canonical local provider for `ctx.longTermMemory` and `ctx.memoryExtractionQueue`. SQLite stores a full JSON snapshot per append-only revision, one current materialized row, Unicode and trigram FTS5 indexes, prepared-turn settlement records, access signals, and restart-safe extraction jobs. Current rows and FTS update in one `BEGIN IMMEDIATE` transaction; tombstones remain readable by exact id but leave recall indexes.

The provider refuses unrelated databases and unknown canonical schema versions. Missing directories and database files are created owner-only on POSIX filesystems. Scope predicates always include workspace, user, and Agent identity. Automatic `prepare()` searches only unexpired `active` entries, while explicit search may request candidate or disputed states. Paged `list()` reads the current materialized view without access accounting and can include expired, superseded, and tombstoned rows for governance.

Active writes require user-stated or successful-tool-result evidence. Common private-key, access-token, password, and API-key forms are rejected in both content and summary at the provider operation so alternate Consumers cannot bypass the tool's checks. Exact normalized kind/content deduplication returns an existing identity and may promote a matching candidate rather than forking it. When remembered content matches a dead `superseded` or `tombstoned` entry, the new identity records `supersedes` and the dead entry gains a `superseded` revision with the reverse `supersededBy` link, both inside one transaction; `forget` only tombstones and never writes supersede links.

Each returned search or recall hit increments `usefulAccessCount` in a fail-open transaction, while a committed injection increments `accessCount`. Retrieval and recall remain available when that accounting cannot commit.

One process owns each canonical database path. The provider claims a pid/boot-id heartbeat row at startup, refreshes it inside every write transaction, and releases it on clean close; startup fails loudly against a fresh foreign heartbeat (a stale one is reclaimed), and a later write by a superseded owner fails loudly instead of silently co-writing.

Extraction admission is idempotent over Scope, session, turn, and source hash; the dedupe check and insert share one `BEGIN IMMEDIATE` transaction so concurrent enqueues from separate connections admit exactly one job. Atomic claims increment attempts and carry an expiring worker lease; expired leases are reclaimable, while a final expired attempt becomes terminal failed. Successful jobs retain memory ids, counts, and an output hash but never raw model output. Schema version 4 adds per-Session outcome observations and bounded explicit-impact ranking; version 3 added the single-owner heartbeat table, version 2 added deterministic content hashes, and version-1 stores migrate in place before the queue is enabled.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `path` | required | Canonical database path; `:memory:` is supported for tests. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist`. |
| `maxSearchLimit` | `50` | Largest accepted result cap. |
| `maxContentChars` | `8000` | Largest memory content in Unicode code points. |
| `maxSummaryChars` | `500` | Largest summary in Unicode code points. |
| `ownerStaleMs` | `30000` | Age at which a foreign ownership heartbeat is considered dead. |

## Model Experience

None, as this trusted provider returns entries only to Consumers and registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Synchronous SQLite statements** — `DatabaseSync` blocks the JavaScript thread while a statement executes.
- **Single-process ownership, heartbeat-enforced** — one live provider and process-local worker must own a canonical database path. A fresh foreign heartbeat fails startup and later writes loudly; a long-idle reader stops refreshing its heartbeat and can be superseded by a new owner. External writers and distributed workers remain unsupported.
- **Legacy counter naming** — `usefulAccessCount` retains its historical retrieval-hit meaning for compatibility. Ranking ignores it; only explicit positive/negative `memory_outcomes` impact ranking.
- **No supersede chain from forgetting** — `forget` tombstones without supersede links because deletion has no replacement; chains form only when the same content is remembered again.
- **Lexical retrieval only** — Unicode and trigram FTS are fused with importance and trust; semantic embeddings are not yet available.
