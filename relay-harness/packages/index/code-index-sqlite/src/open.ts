/**
 * Fail-closed admission for code-index database files.
 *
 * @module @relay-harness/rlh-code-index-sqlite/open
 */

import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  CodeIndexError,
  CODE_INDEX_DB_FOREIGN_APPLICATION,
} from '@relay-harness/rlh-code-index'
import {
  CODE_INDEX_SQLITE_APPLICATION_ID,
  CODE_INDEX_SQLITE_SCHEMA_VERSION,
  DERIVED_USER_TABLES,
  ensureCodeIndexSchema,
} from './ddl.ts'

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
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

/**
 * Drop the entire derived inventory and mark the file versionless so the next
 * {@link ensureCodeIndexSchema} call recreates the schema from scratch. The
 * store is derived data: a schema mismatch never rejects the file, it rebuilds.
 */
function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[]): void {
  for (const name of userTables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`)
  }
  db.exec('PRAGMA user_version = 0')
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Open one code-index store fail-closed: foreign application ids are refused,
 * and an admitted-but-mismatched derived medium rebuilds in place rather than
 * migrating, because every table here is reconstructable index data.
 *
 * Missing filesystem paths are created owner-only (`0700` directory, `0600`
 * file); existing files keep their modes. On any failure the handle is closed
 * before the error propagates.
 * @param path - dedicated database path or `:memory:`; callers own lifecycle (close) after admission.
 * @param journalMode - validated SQLite journal mode; callers without other constraints keep the `wal` default.
 * @returns initialized database handle owned by the caller.
 * @throws {CodeIndexError} with `CODE_INDEX_DB_FOREIGN_APPLICATION` when the
 *   file belongs to another application or carries unregistered user tables.
 */
export async function openCodeIndexDatabase(path: string, journalMode: JournalMode = 'wal'): Promise<DatabaseSync> {
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
    const userTables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== CODE_INDEX_SQLITE_APPLICATION_ID) {
      throw new CodeIndexError(
        `code-index database at "${actual}" belongs to another application`,
        CODE_INDEX_DB_FOREIGN_APPLICATION,
      )
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new CodeIndexError(
        `code-index database at "${actual}" is not an empty or recognized derived index`,
        CODE_INDEX_DB_FOREIGN_APPLICATION,
      )
    }
    const derivedMismatch = version !== CODE_INDEX_SQLITE_SCHEMA_VERSION
      || !userTables.every(name => DERIVED_USER_TABLES.has(name))
    // Apply mutating pragmas only after refusing foreign files.
    // journalMode is a validated closed union, not caller-controlled SQL.
    db.exec('PRAGMA foreign_keys = ON')
    // Writers take BEGIN IMMEDIATE claims and the drain commits per vector batch; a
    // bounded 5 s wait lets a concurrent writer's transaction clear instead of
    // surfacing SQLITE_BUSY to a search or refresh mid-pass (the reference
    // store sets the same timeout).
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    if (applicationId === CODE_INDEX_SQLITE_APPLICATION_ID && derivedMismatch) {
      resetDerivedSchema(db, userTables)
    }
    ensureCodeIndexSchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}
