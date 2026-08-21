# `@deepseek-ai/dsh-memory-sqlite`

English | [中文](README.zh.md)

Canonical local provider for `ctx.longTermMemory` and `ctx.memoryExtractionQueue`. SQLite stores a full JSON snapshot per append-only revision, one current materialized row, Unicode and trigram FTS5 indexes, prepared-turn settlement records, access signals, and restart-safe extraction jobs. Current rows and FTS update in one `BEGIN IMMEDIATE` transaction; tombstones remain readable by exact id but leave recall indexes.

The provider refuses unrelated databases and unknown canonical schema versions. Missing directories and database files are created owner-only on POSIX filesystems. Scope predicates always include workspace, user, and Agent identity. Automatic `prepare()` searches only unexpired `active` entries, while explicit search may request candidate or disputed states.

Active writes require user-stated or successful-tool-result evidence. Common private-key, access-token, password, and API-key forms are rejected in both content and summary at the provider operation so alternate Consumers cannot bypass the tool's checks. Exact normalized kind/content deduplication returns an existing identity and may promote a matching candidate rather than forking it.

Extraction admission is idempotent over Scope, session, turn, and source hash. Atomic claims increment attempts and carry an expiring worker lease; expired leases are reclaimable, while a final expired attempt becomes terminal failed. Successful jobs retain memory ids, counts, and an output hash but never raw model output. Schema version 2 migrates canonical version-1 stores by adding deterministic content hashes before enabling the queue.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `path` | required | Canonical database path; `:memory:` is supported for tests. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist`. |
| `maxSearchLimit` | `50` | Largest accepted result cap. |
| `maxContentChars` | `8000` | Largest memory content in Unicode code points. |
| `maxSummaryChars` | `500` | Largest summary in Unicode code points. |

## Model Experience

None, as this trusted provider returns entries only to Consumers and registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Synchronous SQLite statements** — `DatabaseSync` blocks the JavaScript thread while a statement executes.
- **Single-process owner** — one live provider and process-local worker must own a canonical database path; external writers and distributed workers are unsupported.
- **Lexical retrieval only** — Unicode and trigram FTS are fused with importance and trust; semantic embeddings are not yet available.
