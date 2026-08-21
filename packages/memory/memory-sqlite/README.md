# `@deepseek-ai/dsh-memory-sqlite`

English | [中文](README.zh.md)

Canonical local `ctx.longTermMemory` provider. SQLite stores a full JSON snapshot per append-only revision, one current materialized row, Unicode and trigram FTS5 indexes, prepared-turn settlement records, and access signals. Current rows and FTS update in one `BEGIN IMMEDIATE` transaction; tombstones remain readable by exact id but leave recall indexes.

The provider refuses unrelated databases and unknown canonical schema versions. Missing directories and database files are created owner-only on POSIX filesystems. Scope predicates always include workspace, user, and Agent identity. Automatic `prepare()` searches only unexpired `active` entries, while explicit search may request candidate or disputed states.

Active writes require user-stated or successful-tool-result evidence. Common private-key, access-token, password, and API-key forms are rejected at the provider operation so alternate Consumers cannot bypass the tool's checks.

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
- **Single-process owner** — one live provider must own a canonical database path; external writers and multi-process sharing are unsupported.
- **Lexical retrieval only** — Unicode and trigram FTS are fused with importance and trust; semantic embeddings are not yet available.
