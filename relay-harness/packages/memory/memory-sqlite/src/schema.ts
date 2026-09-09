import { loadNodeSqlite } from '@relay-harness/rlh-sqlite-runtime'
/** Canonical SQLite schema for append-only long-term-memory revisions. */

import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

/** SQLite application id for canonical RLH memory stores (`RLHM`). */
export const MEMORY_SQLITE_APPLICATION_ID = 0x4453484D
/** Canonical schema version. Unlike derived indexes, unknown versions fail closed. */
export const MEMORY_SQLITE_SCHEMA_VERSION = 4

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
  const { DatabaseSync } = loadNodeSqlite()
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
    CREATE TABLE IF NOT EXISTS memory_outcomes (
      id            TEXT PRIMARY KEY,
      memory_id     TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      turn          INTEGER NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN (
        'turn-completed', 'turn-failed', 'assistant-positive', 'assistant-negative',
        'work-completed', 'work-blocked'
      )),
      impact        TEXT NOT NULL CHECK (impact IN ('positive', 'negative', 'neutral')),
      observed_at   INTEGER NOT NULL,
      outcome_json  TEXT NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memory_entries(memory_id) ON DELETE RESTRICT
    ) STRICT
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_outcomes_memory
    ON memory_outcomes(memory_id, observed_at DESC)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_outcomes_session
    ON memory_outcomes(workspace_id, user_id, agent_id, session_id)
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_store_owner (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      pid           INTEGER NOT NULL,
      boot_id       TEXT NOT NULL,
      heartbeat_at  INTEGER NOT NULL
    ) STRICT
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

/** Process identity recorded in the single-owner heartbeat row. */
export interface MemoryStoreOwner {
  readonly pid: number
  readonly bootId: string
}

/** A write attempted after another process claimed the canonical store. */
export class MemoryStoreOwnershipError extends Error {}

let cachedBootId: string | undefined
const localOwnershipReferences = new Map<string, number>()

function ownershipReferenceKey(label: string): string | undefined {
  return label === ':memory:' ? undefined : resolve(label)
}

function processBootId(): string {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    } catch {
      // The proc file exists only on Linux; other hosts fall back to the host
      // name, where pid reuse after a reboot is bounded by heartbeat staleness.
      cachedBootId = hostname()
    }
  }
  return cachedBootId
}

/**
 * Identify the current process as one memory-store owner candidate.
 * @returns pid plus a per-boot (Linux) or per-host identity.
 */
export function currentMemoryStoreOwner(): MemoryStoreOwner {
  return { pid: process.pid, bootId: processBootId() }
}

/**
 * Atomically claim single-process ownership of one canonical store.
 * @param db - initialized canonical database handle.
 * @param owner - current process identity.
 * @param staleMs - age at which a foreign heartbeat is considered dead.
 * @param label - database path used in failure guidance.
 * @throws when a fresh heartbeat from another process still owns the store.
 */
export function claimMemoryStoreOwnership(
  db: DatabaseSync,
  owner: MemoryStoreOwner,
  staleMs: number,
  label: string,
): void {
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(
      'SELECT pid, boot_id, heartbeat_at FROM memory_store_owner WHERE id = 1',
    ).get() as { pid: number; boot_id: string; heartbeat_at: number } | undefined
    if (row !== undefined && (row.pid !== owner.pid || row.boot_id !== owner.bootId)
      && row.heartbeat_at > now - staleMs) {
      throw new MemoryStoreOwnershipError(
        `memory database at "${label}" has a fresh owner heartbeat from process ${row.pid}`
        + ` (boot ${row.boot_id}, ${now - row.heartbeat_at}ms old); run one memory-owning process`
        + ' per database path, or disable the memory-sqlite plugin in the other process',
      )
    }
    db.prepare(`
      INSERT INTO memory_store_owner (id, pid, boot_id, heartbeat_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        boot_id = excluded.boot_id,
        heartbeat_at = excluded.heartbeat_at
    `).run(owner.pid, owner.bootId, now)
    db.exec('COMMIT')
    const key = ownershipReferenceKey(label)
    if (key !== undefined) localOwnershipReferences.set(key, (localOwnershipReferences.get(key) ?? 0) + 1)
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Refresh this process's ownership heartbeat inside an open write transaction.
 * @param db - handle with a write transaction already open.
 * @param owner - current process identity.
 * @param staleMs - age at which a foreign heartbeat can be reclaimed.
 * @param label - database path used in failure guidance.
 * @throws when another live process took over the store while this one was idle.
 */
export function refreshMemoryStoreOwner(
  db: DatabaseSync,
  owner: MemoryStoreOwner,
  staleMs: number,
  label: string,
): void {
  const now = Date.now()
  const changed = db.prepare(`
    UPDATE memory_store_owner
    SET pid = ?, boot_id = ?, heartbeat_at = ?
    WHERE id = 1 AND ((pid = ? AND boot_id = ?) OR heartbeat_at <= ?)
  `).run(owner.pid, owner.bootId, now, owner.pid, owner.bootId, now - staleMs).changes
  if (changed !== 1) {
    throw new MemoryStoreOwnershipError(`memory database at "${label}" is owned by another live process`)
  }
}

/**
 * Release ownership on clean provider shutdown so an immediate restart is admitted.
 * @param db - initialized canonical database handle.
 * @param owner - current process identity.
 * @param label - database path used to retain same-process sibling providers.
 */
export function releaseMemoryStoreOwnership(db: DatabaseSync, owner: MemoryStoreOwner, label: string): void {
  const key = ownershipReferenceKey(label)
  if (key !== undefined) {
    const references = localOwnershipReferences.get(key) ?? 0
    if (references > 1) {
      localOwnershipReferences.set(key, references - 1)
      return
    }
    localOwnershipReferences.delete(key)
  }
  db.prepare('DELETE FROM memory_store_owner WHERE id = 1 AND pid = ? AND boot_id = ?')
    .run(owner.pid, owner.bootId)
}
