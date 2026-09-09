import { loadNodeSqlite } from '@relay-harness/rlh-sqlite-runtime'
/**
 * Schema + open-time helpers for the SQLite storage backend: the physical
 * layout version, the database open/configure sequence (permissions, pragmas,
 * version stamp/reject), and the unit metadata tables. Unit record tables are
 * created per descriptor in `unit.ts`.
 * @module @relay-harness/rlh-storage-sqlite/schema
 */

import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StorageError } from '@relay-harness/rlh-storage'

/**
 * The on-disk physical layout version, stored in `PRAGMA user_version`.
 * Orthogonal to each unit's own `version` (stamped per unit in the `units`
 * row). Bumped only on a breaking change to the table layout; any other
 * stamped version rejects — this unreleased format has no migrations.
 */
export const STORAGE_SQLITE_SCHEMA_VERSION = 1

/**
 * Application id stamped into `PRAGMA application_id` and checked at open, so
 * a database belonging to another application is refused instead of being
 * adopted and co-written. Follows the reserved Relay Harness SQLite sequence
 * (`...4850` session persistence, `...4851` session query).
 */
export const STORAGE_SQLITE_APPLICATION_ID = 0x44534852

/**
 * Journal modes the backend will run under. `wal` is the default; the
 * rollback-journal modes (`delete`/`truncate`/`persist`) exist for
 * filesystems where WAL's shared-memory files do not work (network mounts).
 * `memory`/`off` are excluded: dropping journal durability silently
 * contradicts the durability clause of the KV backend contract.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/* jscpd:ignore-start -- deliberately mirrors the session-persistence-sqlite /
   session-query-sqlite open and ownership sequence; all three SQLite backends
   share the same order (create owner-only, refuse foreign content, then apply
   mutating pragmas and schema), and the shared medium helper is deferred to the
   log-facet migration so the session packages stay untouched this phase (see
   the domain KV storage Agent Note's reuse audit). */
/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity when another principal can replace the database entry in its
 * parent directory.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open, validate ownership of, and initialize a storage database. Missing
 * directories and database files are created owner-only (`:memory:` skips
 * filesystem setup). A database stamped with another application id, unstamped
 * but holding user tables, stamped with a foreign schema version, or stamped
 * as ours without the expected unit metadata tables is refused before any
 * write; a zero-version empty database is stamped with
 * {@link STORAGE_SQLITE_APPLICATION_ID} and {@link STORAGE_SQLITE_SCHEMA_VERSION}.
 * @param path - the SQLite database file to open, or `:memory:`.
 * @param journalMode - validated journal pragma.
 * @returns the open handle with pragmas applied and the unit metadata tables ensured.
 */
export async function openDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new (loadNodeSqlite().DatabaseSync)(actual)
  try {
    configureDatabase(db, actual, journalMode)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: JournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  // `PRAGMA user_version` and `PRAGMA application_id` each return exactly one row.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  const userTables = listUserTables(db)
  if (applicationId !== 0 && applicationId !== STORAGE_SQLITE_APPLICATION_ID) {
    throw new StorageError(
      'foreign-medium',
      `storage database at "${path}" has application id ${applicationId}, expected ${STORAGE_SQLITE_APPLICATION_ID}`,
    )
  }
  if (applicationId === 0 && userTables.length > 0) {
    throw new StorageError(
      'foreign-medium',
      `storage database at "${path}" already holds foreign user tables (${userTables.join(', ')})`,
    )
  }
  if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
    throw new StorageError(
      'version-mismatch',
      `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (${STORAGE_SQLITE_SCHEMA_VERSION})`,
    )
  }
  if (applicationId === STORAGE_SQLITE_APPLICATION_ID) assertOwnedTables(path, userTables)
  // Mutating pragmas and DDL run only after refusing foreign content.
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  /* jscpd:ignore-end */
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) {
    // Stamp fresh databases LAST: the stamps assert the layout is complete,
    // so a failure above must leave the medium unstamped (a re-open after
    // the obstruction is cleared retries materialization from scratch).
    db.exec(`PRAGMA application_id = ${STORAGE_SQLITE_APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
  }
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

/**
 * Validate the user tables of a database stamped as ours: both unit metadata
 * tables must be present and every other table must be a unit record table
 * (`u_<unit>_<table>`; both segments match the hub's `UNIT_NAME_RE`, so the
 * `u_`-prefixed segment charset check cannot mistake a foreign table).
 */
function assertOwnedTables(path: string, userTables: readonly string[]): void {
  const missing = [...OWNED_METADATA_TABLES].filter(name => !userTables.includes(name))
  if (missing.length > 0) {
    throw new StorageError(
      'foreign-medium',
      `storage database at "${path}" is stamped as a storage backend but is missing its ${missing.join(', ')} table(s)`,
    )
  }
  const unknownTables = userTables.filter(name => !OWNED_METADATA_TABLES.has(name) && !RECORD_TABLE_RE.test(name))
  if (unknownTables.length > 0) {
    throw new StorageError(
      'foreign-medium',
      `storage database at "${path}" has unrecognized user tables: ${unknownTables.join(', ')}`,
    )
  }
}

const OWNED_METADATA_TABLES = new Set(['units', 'unit_globals'])
// `recordTableName` yields `u_<unit>_<table>` over `UNIT_NAME_RE` segments,
// so every legitimate record table is `u_` plus lowercase unit/table charset.
const RECORD_TABLE_RE = /^u_[a-z][a-z0-9_]*$/

/**
 * Physical table name for one unit table. Both segments are validated against
 * `UNIT_NAME_RE` before reaching this, so the result is safe to interpolate
 * into DDL and prepared-statement text.
 * @param unit - Validated unit name.
 * @param table - Validated table name.
 * @returns the `u_<unit>_<table>` identifier.
 */
export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}
