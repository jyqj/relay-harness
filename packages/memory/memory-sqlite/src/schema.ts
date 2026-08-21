/** Canonical SQLite schema for append-only long-term-memory revisions. */

import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** SQLite application id for canonical DSH memory stores (`DSHM`). */
export const MEMORY_SQLITE_APPLICATION_ID = 0x4453484D
/** Canonical schema version. Unlike derived indexes, unknown versions fail closed. */
export const MEMORY_SQLITE_SCHEMA_VERSION = 2

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open and initialize one canonical memory store.
 * @param path - dedicated database path or `:memory:`.
 * @param journalMode - validated journal mode.
 * @returns initialized handle owned by the provider.
 */
export async function openMemoryDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    const applicationId = pragmaNumber(db, 'application_id')
    const version = pragmaNumber(db, 'user_version')
    const tables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== MEMORY_SQLITE_APPLICATION_ID) {
      throw new Error(`memory database at "${actual}" belongs to another application`)
    }
    if (applicationId === 0 && tables.length > 0) {
      throw new Error(`memory database at "${actual}" is not empty or recognized`)
    }
    if (applicationId === MEMORY_SQLITE_APPLICATION_ID && (version < 1 || version > MEMORY_SQLITE_SCHEMA_VERSION)) {
      throw new Error(
        `memory database at "${actual}" has unsupported schema version ${version}; expected at most ${MEMORY_SQLITE_SCHEMA_VERSION}`,
      )
    }
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    if (applicationId === MEMORY_SQLITE_APPLICATION_ID && version === 1) migrateVersionOne(db)
    ensureSchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function pragmaNumber(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  return (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name] as number
}

function listUserTables(db: DatabaseSync): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>).map(row => row.name)
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${MEMORY_SQLITE_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_revisions (
      memory_id     TEXT NOT NULL,
      revision      INTEGER NOT NULL,
      workspace_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      entry_json    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (memory_id, revision)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      memory_id       TEXT PRIMARY KEY,
      revision        INTEGER NOT NULL,
      workspace_id    TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      kind            TEXT NOT NULL,
      status          TEXT NOT NULL,
      trust           TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      importance      INTEGER NOT NULL,
      confidence      REAL NOT NULL,
      valid_until     INTEGER,
      updated_at      INTEGER NOT NULL,
      access_count    INTEGER NOT NULL,
      useful_access_count INTEGER NOT NULL,
      entry_json      TEXT NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_entries_scope_status
    ON memory_entries(workspace_id, user_id, agent_id, status, updated_at)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_entries_scope_content
    ON memory_entries(workspace_id, user_id, agent_id, kind, content_hash)
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_unicode USING fts5(
      memory_id UNINDEXED,
      content,
      summary,
      tokenize = 'unicode61'
    )
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_trigram USING fts5(
      memory_id UNINDEXED,
      content,
      summary,
      tokenize = 'trigram'
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_turns (
      handle          TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      turn            INTEGER NOT NULL,
      query           TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      recalled_ids_json TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'aborted')),
      reason          TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE (workspace_id, user_id, agent_id, session_id, turn)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_signals (
      id            TEXT PRIMARY KEY,
      memory_id     TEXT NOT NULL,
      signal        TEXT NOT NULL CHECK (signal IN ('candidate_hit', 'injected', 'user_confirmed', 'user_rejected')),
      session_id    TEXT,
      turn          INTEGER,
      created_at    INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (memory_id) REFERENCES memory_entries(memory_id) ON DELETE RESTRICT
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
      id            TEXT PRIMARY KEY,
      dedupe_key    TEXT NOT NULL UNIQUE,
      workspace_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      turn          INTEGER NOT NULL,
      source_hash   TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL,
      available_at  INTEGER NOT NULL,
      lease_owner   TEXT,
      lease_until   INTEGER,
      last_error    TEXT,
      result_json   TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_extraction_jobs_claim
    ON memory_extraction_jobs(status, available_at, lease_until, created_at)
  `)
  db.exec(`PRAGMA user_version = ${MEMORY_SQLITE_SCHEMA_VERSION}`)
}

function migrateVersionOne(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec("ALTER TABLE memory_entries ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
    const rows = db.prepare('SELECT memory_id, kind, entry_json FROM memory_entries').all() as Array<{
      memory_id: string
      kind: string
      entry_json: string
    }>
    const update = db.prepare('UPDATE memory_entries SET content_hash = ? WHERE memory_id = ?')
    for (const row of rows) {
      const entry = JSON.parse(row.entry_json) as { content?: unknown }
      if (typeof entry.content !== 'string') throw new Error(`memory ${row.memory_id} has invalid canonical content`)
      update.run(memoryContentHash(row.kind, entry.content), row.memory_id)
    }
    db.exec('COMMIT')
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Compute the deterministic exact-dedup key for one memory kind and content.
 * @param kind - semantic memory kind.
 * @param content - canonical memory content.
 * @returns SHA-256 hex over normalized kind and content.
 */
export function memoryContentHash(kind: string, content: string): string {
  const normalized = content.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
  return createHash('sha256').update(`${kind}\0${normalized}`).digest('hex')
}
