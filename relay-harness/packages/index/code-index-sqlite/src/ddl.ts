/** Canonical SQLite schema for the disposable local code-index store. */

import type { DatabaseSync } from 'node:sqlite'

/**
 * SQLite application id protecting unrelated databases from derived resets
 * (ASCII `"CIDX"`).
 */
export const CODE_INDEX_SQLITE_APPLICATION_ID = 0x43494458

/** Current derived schema version. Incompatible databases reset in place. */
export const CODE_INDEX_SQLITE_SCHEMA_VERSION = 8

/**
 * Metadata keys owned by this store. Epochs survive reopening an admitted
 * database and reset only when the derived medium rebuilds.
 */
export const CODE_INDEX_METADATA_INDEX_EPOCH = 'index_epoch'

/** Metadata key storing the evidence epoch; bumped by admissible external evidence. */
export const CODE_INDEX_METADATA_EVIDENCE_EPOCH = 'evidence_epoch'

/** Metadata key storing vector-materialization commits, separate from runtime evidence. */
export const CODE_INDEX_METADATA_EMBEDDING_EPOCH = 'embedding_epoch'

/**
 * Metadata key prefix for per-file export fingerprints; the full key is this
 * prefix followed by the workspace-relative file path. Rows are writer-owned
 * state deleted with their file and read back through the graph read facet.
 */
export const CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX = 'export_fingerprint:'

/**
 * Every user table this schema may ever create, including FTS5 shadow tables.
 * Rebuild-on-mismatch drops each one before recreating the schema from scratch;
 * any other user table under our application id joins the same drop list,
 * because everything here is reconstructable derived data.
 */
export const DERIVED_USER_TABLES = new Set([
  'metadata',
  'files',
  'chunks',
  // Each FTS5 entry below lists its virtual table plus the five internal
  // shadow tables SQLite materializes beside it (`*_data`, `*_idx`,
  // `*_content`, `*_docsize`, `*_config`); admission scans plain user tables,
  // and missing any shadow would misread a healthy database as foreign.
  'chunks_fts',
  'chunks_fts_data',
  'chunks_fts_idx',
  'chunks_fts_content',
  'chunks_fts_docsize',
  'chunks_fts_config',
  'files_fts',
  'files_fts_data',
  'files_fts_idx',
  'files_fts_content',
  'files_fts_docsize',
  'files_fts_config',
  'file_paths_fts',
  'file_paths_fts_data',
  'file_paths_fts_idx',
  'file_paths_fts_content',
  'file_paths_fts_docsize',
  'file_paths_fts_config',
  'symbols',
  'symbols_fts',
  'symbols_fts_data',
  'symbols_fts_idx',
  'symbols_fts_content',
  'symbols_fts_docsize',
  'symbols_fts_config',
  'imports',
  'symbol_refs',
  'call_edges',
  'test_edges',
  'literal_index',
  'chunks_vec',
  'embedding_generations',
  'code_embed_jobs',
  'literal_fts',
  'literal_fts_data',
  'literal_fts_idx',
  'literal_fts_content',
  'literal_fts_docsize',
  'literal_fts_config',
])

/**
 * Create or complete the derived schema inside an already-validated handle.
 *
 * Idempotent: every statement is `CREATE ... IF NOT EXISTS`, so reopening a
 * same-version database preserves its rows. Fresh and rebuilt databases receive
 * epoch metadata seeded at `'0'`; existing rows keep their committed values.
 * @param db - handle whose application id and unknown-table inventory were
 *   already screened by {@link ./open.ts!openCodeIndexDatabase | open}.
 */
export function ensureCodeIndexSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${CODE_INDEX_SQLITE_APPLICATION_ID}`)
  // Key-value ledger; P1 seeds the epoch pair consumed by dual-epoch writes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `)
  db.prepare(`
    INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)
  `).run(CODE_INDEX_METADATA_INDEX_EPOCH, '0')
  db.prepare(`
    INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)
  `).run(CODE_INDEX_METADATA_EVIDENCE_EPOCH, '0')
  db.prepare(`
    INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)
  `).run(CODE_INDEX_METADATA_EMBEDDING_EPOCH, '0')
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_path         TEXT PRIMARY KEY,
      language          TEXT NOT NULL,
      content_hash      TEXT NOT NULL,
      mtime             REAL NOT NULL,
      size              INTEGER NOT NULL,
      summary           TEXT NOT NULL DEFAULT '',
      content_excerpt   TEXT NOT NULL DEFAULT '',
      parser_tier       TEXT NOT NULL DEFAULT 'generic',
      parser_confidence REAL NOT NULL DEFAULT 0.5,
      is_test_file      INTEGER NOT NULL DEFAULT 0,
      indexed_at        TEXT NOT NULL
    ) STRICT
  `)
  // chunk_id follows the `chunk:<file_path>:<chunk_index>` layout the writer owns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id          TEXT PRIMARY KEY,
      file_path         TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
      chunk_index       INTEGER NOT NULL,
      start_line        INTEGER NOT NULL,
      end_line          INTEGER NOT NULL,
      breadcrumb        TEXT NOT NULL DEFAULT '',
      symbol_name       TEXT,
      symbol_kind       TEXT,
      text              TEXT NOT NULL,
      text_encoding     TEXT NOT NULL DEFAULT 'plain',
      token_estimate    INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path, chunk_index)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol_name)
  `)
  // FTS5 rowid alignment: chunks_fts.rowid equals the aligned chunks.rowid.
  // Actual synchronization is application-maintained by the provider's writer.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      breadcrumb, symbol_name, text,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `)
  // files_fts rows are mirrored from files with explicit rowids (rowid-aligned).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      file_path UNINDEXED, summary, content_excerpt,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_paths_fts USING fts5(
      file_path,
      tokenize = 'trigram'
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS file_paths_fts_ai AFTER INSERT ON files BEGIN
      INSERT INTO file_paths_fts(rowid, file_path) VALUES (new.rowid, new.file_path);
    END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS file_paths_fts_ad AFTER DELETE ON files BEGIN
      DELETE FROM file_paths_fts WHERE rowid = old.rowid;
    END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS file_paths_fts_au AFTER UPDATE OF file_path ON files BEGIN
      DELETE FROM file_paths_fts WHERE rowid = old.rowid;
      INSERT INTO file_paths_fts(rowid, file_path) VALUES (new.rowid, new.file_path);
    END;
  `)
  // ── Graph tier (schema v2), trimmed from the reference implementation's
  // index_v1.sql. Rows are file-owned derived data; every child table carries
  // ON DELETE CASCADE so a files-row delete removes its graph rows, and
  // symbols_fts heals through the triggers below (the writer still deletes
  // symbols rows explicitly — a cascaded second delete deletes zero rows).
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      symbol_id         TEXT PRIMARY KEY,
      file_path         TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      container         TEXT,
      start_line        INTEGER NOT NULL,
      end_line          INTEGER NOT NULL,
      start_col         INTEGER,
      end_col           INTEGER,
      signature         TEXT,
      doc               TEXT,
      parser_tier       TEXT,
      parser_confidence REAL,
      qname             TEXT,
      parent_symbol_id  TEXT,
      export_name       TEXT,
      is_default_export INTEGER DEFAULT 0,
      symbol_uid        TEXT UNIQUE,
      framework_role    TEXT,
      receiver_type     TEXT,
      param_types       TEXT,
      return_type       TEXT,
      param_count       INTEGER,
      base_types        TEXT,
      implements        TEXT
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qname)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_uid ON symbols(symbol_uid)')
  // Rowid-aligned with symbols through the triggers; LIKE-accelerated by trigram.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name,
      tokenize = 'trigram'
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_fts_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name) VALUES (new.rowid, new.name);
    END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_fts_ad AFTER DELETE ON symbols BEGIN
      DELETE FROM symbols_fts WHERE rowid = old.rowid;
    END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS symbols_fts_au AFTER UPDATE OF name ON symbols BEGIN
      DELETE FROM symbols_fts WHERE rowid = old.rowid;
      INSERT INTO symbols_fts(rowid, name) VALUES (new.rowid, new.name);
    END;
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      rowid          INTEGER PRIMARY KEY,
      file_path      TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
      import_string  TEXT NOT NULL,
      resolved_path  TEXT,
      imported_name  TEXT,
      alias          TEXT,
      is_namespace   INTEGER DEFAULT 0,
      is_default     INTEGER DEFAULT 0,
      is_reexport    INTEGER DEFAULT 0
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_path)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_refs (
      ref_id                TEXT PRIMARY KEY,
      file_path             TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
      symbol_name           TEXT,
      container             TEXT,
      ref_kind              TEXT,
      line                  INTEGER,
      col                   INTEGER,
      target_symbol_id      TEXT,
      target_file_path      TEXT,
      target_symbol_uid     TEXT,
      ref_name              TEXT,
      resolution_kind       TEXT,
      resolution_confidence REAL,
      resolution_strategy   TEXT,
      parser_tier           TEXT,
      parser_confidence     REAL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_edges (
      edge_id               TEXT PRIMARY KEY,
      file_path             TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
      caller_symbol         TEXT,
      callee_symbol         TEXT,
      line                  INTEGER,
      start_col             INTEGER,
      target_symbol_id      TEXT,
      target_file_path      TEXT,
      caller_symbol_id      TEXT,
      caller_symbol_uid     TEXT,
      callee_symbol_uid     TEXT,
      dispatch_kind         TEXT,
      call_kind             TEXT,
      resolution_kind       TEXT,
      resolution_confidence REAL,
      resolution_strategy   TEXT,
      receiver_expr         TEXT,
      arg_count             INTEGER,
      is_optional_chain     INTEGER DEFAULT 0,
      is_awaited            INTEGER DEFAULT 0,
      is_constructor        INTEGER DEFAULT 0,
      parser_tier           TEXT,
      parser_confidence     REAL
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_ce_caller_uid ON call_edges(caller_symbol_uid)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_ce_callee_uid ON call_edges(callee_symbol_uid)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_ce_file_line ON call_edges(file_path, line)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_edges (
      edge_id        TEXT PRIMARY KEY,
      test_file_path TEXT NOT NULL,
      code_file_path TEXT NOT NULL,
      reason         TEXT,
      confidence     REAL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS literal_index (
      literal_id           TEXT PRIMARY KEY,
      file_path            TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
      literal              TEXT,
      literal_kind         TEXT,
      line                 INTEGER,
      container            TEXT,
      confidence           REAL,
      enclosing_symbol_uid TEXT
    ) STRICT
  `)
  // Rowid-aligned with literal_index through the triggers, mirroring the
  // symbols_fts precedent. Both mirrored columns are nullable, so the triggers
  // coalesce to '' — FTS5 rejects NULL column values outright.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS literal_fts USING fts5(
      literal, literal_kind,
      tokenize = 'unicode61'
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS literal_fts_ai AFTER INSERT ON literal_index BEGIN
      INSERT INTO literal_fts(rowid, literal, literal_kind)
      VALUES (new.rowid, COALESCE(new.literal, ''), COALESCE(new.literal_kind, ''));
    END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS literal_fts_ad AFTER DELETE ON literal_index BEGIN
      DELETE FROM literal_fts WHERE rowid = old.rowid;
    END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS literal_fts_au AFTER UPDATE OF literal, literal_kind ON literal_index BEGIN
      DELETE FROM literal_fts WHERE rowid = old.rowid;
      INSERT INTO literal_fts(rowid, literal, literal_kind)
      VALUES (new.rowid, COALESCE(new.literal, ''), COALESCE(new.literal_kind, ''));
    END;
  `)
  // ── Vector tier (schema v8). Generation identity covers endpoint/model,
  // configured dimensions, normalization, quantizer, and chunker. Keeping the
  // identity in its own durable row lets model/endpoint switches coexist and
  // lets the provider reconcile coverage for unchanged chunks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_generations (
      generation_id        TEXT PRIMARY KEY,
      provider_id          TEXT NOT NULL,
      endpoint_identity    TEXT NOT NULL,
      model                TEXT NOT NULL,
      configured_dimensions INTEGER,
      dimension_mode       TEXT NOT NULL CHECK (dimension_mode IN ('fixed', 'provider-default')),
      normalization_version TEXT NOT NULL,
      quantizer_version     TEXT NOT NULL,
      chunker_version       TEXT NOT NULL,
      created_at            TEXT NOT NULL
    ) STRICT
  `)
  // One int8-quantized embedding row per chunk and generation; the math lives
  // in the search package's vector-math
  // module and this table only enforces its storage contract: `q` holds the
  // byte view of the Int8Array (one byte per dimension, see
  // `@relay-harness/rlh-code-index-search/vector-math`), `norm` is the ORIGINAL
  // float norm captured before quantization, and `chunk_rowid` denormalizes
  // `chunks.rowid` so readers join rowid-aligned without a lookup. The
  // composite `(chunk_id, generation_id)` primary key is what lets vectors of
  // different embedding configurations coexist; the `chunks` foreign key still
  // cascades a chunk delete here exactly as it does through the other
  // chunk-owned tables. The scalar columns are STRICT-typed scalars only — per
  // the BLOB binding contract, no scalar value ever passes through the `q`
  // column.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks_vec (
      chunk_id    TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
      chunk_rowid INTEGER NOT NULL,
      generation_id TEXT NOT NULL REFERENCES embedding_generations(generation_id) ON DELETE CASCADE,
      model       TEXT NOT NULL,
      dim         INTEGER NOT NULL,
      format      TEXT NOT NULL DEFAULT 'int8' CHECK (format = 'int8'),
      scale       REAL NOT NULL,
      q           BLOB NOT NULL,
      norm        REAL NOT NULL,
      PRIMARY KEY (chunk_id, generation_id)
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vec_generation ON chunks_vec(generation_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vec_model ON chunks_vec(model)')
  // Embedding job queue, trimmed from the memory store's
  // extraction-jobs table. Idempotency is double-keyed: `dedupe_key` is the
  // UNIQUE derived identity and `(chunk_id, generation_id, content_hash)` is the
  // semantic key — a re-enqueue of the same chunk text under the same generation is
  // a no-op, while a content revision is a distinct job. `chunk_id` cascades
  // from `chunks` so re-chunking a file purges its stale jobs with the deleted
  // chunk rows instead of leaving them to fail against replaced text.
  // `result_json` stays NULL by contract: a completed job's result IS its
  // `chunks_vec` row, written by the drain inside the embedding-epoch
  // transaction; only `usage_json` records the provider spend.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_embed_jobs (
      id            TEXT PRIMARY KEY,
      dedupe_key    TEXT NOT NULL UNIQUE,
      chunk_id      TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
      generation_id TEXT NOT NULL REFERENCES embedding_generations(generation_id) ON DELETE CASCADE,
      model         TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      payload_json  TEXT NOT NULL DEFAULT '{}',
      status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      reconcile_resets INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL,
      available_at  INTEGER NOT NULL,
      lease_owner   TEXT,
      lease_until   INTEGER,
      last_error    TEXT,
      result_json   TEXT,
      usage_json    TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE (chunk_id, generation_id, content_hash)
    ) STRICT
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS code_embed_jobs_claim
    ON code_embed_jobs(generation_id, status, available_at, lease_until, created_at)
  `)
  db.exec(`PRAGMA user_version = ${CODE_INDEX_SQLITE_SCHEMA_VERSION}`)
}
