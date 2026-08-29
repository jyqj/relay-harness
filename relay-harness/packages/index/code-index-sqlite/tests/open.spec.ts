import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodeIndexError,
  CODE_INDEX_DB_FOREIGN_APPLICATION,
} from '@relay-harness/rlh-code-index'
import {
  CODE_INDEX_METADATA_EVIDENCE_EPOCH,
  CODE_INDEX_METADATA_INDEX_EPOCH,
  CODE_INDEX_SQLITE_APPLICATION_ID,
  CODE_INDEX_SQLITE_SCHEMA_VERSION,
} from '../src/ddl.ts'
import { openCodeIndexDatabase } from '../src/open.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rlh-code-index-'))
  temporaryDirectories.push(directory)
  return join(directory, 'index.db')
}

function metadataValue(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

function pragmaNumber(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  return (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name] as number
}

function tableCount(db: DatabaseSync, name: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
  ).get(name) as { n: number }).n
}

function insertIndexedFile(db: DatabaseSync, filePath: string): void {
  db.prepare(`
    INSERT INTO files (
      file_path, language, content_hash, mtime, size, is_test_file, indexed_at
    ) VALUES (?, 'typescript', 'hash', 1.5, 10, 0, '2026-08-27T00:00:00Z')
  `).run(filePath)
}

/** Capture a rejection so both its class and its stable code can be asserted. */
async function admissionFailure(path: string): Promise<unknown> {
  return openCodeIndexDatabase(path).then(() => undefined, (caught: unknown) => caught)
}

describe('code-index database admission', () => {
  it('initializes an empty filesystem path owner-only and seeds the epoch pair at zero', async () => {
    const path = await databasePath()
    const db = await openCodeIndexDatabase(path)
    expect(pragmaNumber(db, 'application_id')).toBe(CODE_INDEX_SQLITE_APPLICATION_ID)
    expect(pragmaNumber(db, 'user_version')).toBe(CODE_INDEX_SQLITE_SCHEMA_VERSION)
    expect(metadataValue(db, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('0')
    expect(metadataValue(db, CODE_INDEX_METADATA_EVIDENCE_EPOCH)).toBe('0')
    // Writers wait a bounded 5 s on a concurrent transaction instead of
    // surfacing SQLITE_BUSY mid-pass. node:sqlite surfaces the pragma as `timeout`.
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000)
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    db.close()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('reopening an admitted same-version database preserves rows and epoch values', async () => {
    const path = await databasePath()
    const first = await openCodeIndexDatabase(path)
    insertIndexedFile(first, 'src/a.ts')
    first.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('7', CODE_INDEX_METADATA_INDEX_EPOCH)
    first.close()

    const second = await openCodeIndexDatabase(path)
    expect((second.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(1)
    expect(metadataValue(second, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('7')
    second.close()
  })

  it('rejects a foreign application id without mutating the file', async () => {
    const path = await databasePath()
    const foreign = new DatabaseSync(path)
    foreign.exec(`PRAGMA application_id = ${CODE_INDEX_SQLITE_APPLICATION_ID + 1}`)
    foreign.close()

    const error = await admissionFailure(path)
    expect(error).toBeInstanceOf(CodeIndexError)
    expect((error as CodeIndexError).code).toBe(CODE_INDEX_DB_FOREIGN_APPLICATION)
    const after = new DatabaseSync(path)
    expect(pragmaNumber(after, 'user_version')).toBe(0)
    after.close()
  })

  it('rejects a database carrying user tables under no registered application id', async () => {
    const path = await databasePath()
    const unregistered = new DatabaseSync(path)
    unregistered.exec('CREATE TABLE unknown_owner (x TEXT)')
    unregistered.close()

    const error = await admissionFailure(path)
    expect(error).toBeInstanceOf(CodeIndexError)
    expect((error as CodeIndexError).code).toBe(CODE_INDEX_DB_FOREIGN_APPLICATION)
  })

  it('rebuilds in place when the schema version is ahead of this reader and resets derived state', async () => {
    const path = await databasePath()
    const seeded = await openCodeIndexDatabase(path)
    insertIndexedFile(seeded, 'src/stale.ts')
    seeded.prepare("INSERT INTO metadata (key, value) VALUES ('canary', 'stale')").run()
    seeded.close()

    const bumped = new DatabaseSync(path)
    bumped.exec(`PRAGMA user_version = ${CODE_INDEX_SQLITE_SCHEMA_VERSION + 98}`)
    bumped.close()

    const reopened = await openCodeIndexDatabase(path)
    expect(pragmaNumber(reopened, 'user_version')).toBe(CODE_INDEX_SQLITE_SCHEMA_VERSION)
    expect(metadataValue(reopened, 'canary')).toBeUndefined()
    expect(metadataValue(reopened, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('0')
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0)
    reopened.close()
  })

  it('rebuilds in place when an admitted database carries unrecognized user tables', async () => {
    const path = await databasePath()
    const seeded = await openCodeIndexDatabase(path)
    insertIndexedFile(seeded, 'src/b.ts')
    seeded.close()

    const tampered = new DatabaseSync(path)
    tampered.exec('CREATE TABLE legacy_extra (x INTEGER)')
    tampered.close()

    const reopened = await openCodeIndexDatabase(path)
    expect(pragmaNumber(reopened, 'user_version')).toBe(CODE_INDEX_SQLITE_SCHEMA_VERSION)
    expect(tableCount(reopened, 'legacy_extra')).toBe(0)
    expect(tableCount(reopened, 'chunks')).toBe(1)
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0)
    reopened.close()
  })

  it('propagates file-creation failures other than EEXIST', async () => {
    await expect(openCodeIndexDatabase(join(tmpdir(), 'rlh-code-index-\0rejected.db')))
      .rejects.toThrow(/null bytes/i)
  })

  it('rebuilds a schema-v1 store in place up to v2, resetting epochs and derived content', async () => {
    const path = await databasePath()
    // Hand-craft a v1-era store: admitted tables and application id, but no
    // graph tier and user_version = 1.
    const v1 = await openCodeIndexDatabase(path)
    insertIndexedFile(v1, 'src/old.ts')
    v1.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('5', CODE_INDEX_METADATA_INDEX_EPOCH)
    for (const trigger of ['symbols_fts_ai', 'symbols_fts_ad', 'symbols_fts_au']) {
      v1.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    }
    for (const table of ['literal_index', 'test_edges', 'call_edges', 'symbol_refs', 'imports', 'symbols_fts', 'symbols']) {
      v1.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    v1.exec('PRAGMA user_version = 1')
    v1.close()
    const before = new DatabaseSync(path)
    expect(tableCount(before, 'symbols')).toBe(0)
    before.close()

    const reopened = await openCodeIndexDatabase(path)
    expect(pragmaNumber(reopened, 'user_version')).toBe(CODE_INDEX_SQLITE_SCHEMA_VERSION)
    // The rebuilt medium carries the v2 graph tier and clean derived state.
    expect(tableCount(reopened, 'symbols')).toBe(1)
    expect(tableCount(reopened, 'symbols_fts')).toBe(1)
    expect(tableCount(reopened, 'call_edges')).toBe(1)
    expect(tableCount(reopened, 'literal_index')).toBe(1)
    expect(metadataValue(reopened, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('0')
    expect(metadataValue(reopened, CODE_INDEX_METADATA_EVIDENCE_EPOCH)).toBe('0')
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0)
    reopened.close()
  })

  it('rebuilds a schema-v2 store in place up to v3, adding the literal FTS mirror', async () => {
    const path = await databasePath()
    // Hand-craft a v2-era store: the admitted v3 medium minus the literal
    // mirror tier, pinned at user_version = 2.
    const v2 = await openCodeIndexDatabase(path)
    insertIndexedFile(v2, 'src/old.ts')
    v2.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('9', CODE_INDEX_METADATA_INDEX_EPOCH)
    for (const trigger of ['literal_fts_ai', 'literal_fts_ad', 'literal_fts_au']) {
      v2.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    }
    for (const table of [
      'literal_fts',
      'literal_fts_data',
      'literal_fts_idx',
      'literal_fts_content',
      'literal_fts_docsize',
      'literal_fts_config',
    ]) {
      v2.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    v2.exec('PRAGMA user_version = 2')
    v2.close()

    const reopened = await openCodeIndexDatabase(path)
    expect(pragmaNumber(reopened, 'user_version')).toBe(CODE_INDEX_SQLITE_SCHEMA_VERSION)
    // The rebuilt medium carries the literal mirror and clean derived state.
    expect(tableCount(reopened, 'literal_fts')).toBe(1)
    expect(tableCount(reopened, 'literal_fts_content')).toBe(1)
    expect(tableCount(reopened, 'literal_index')).toBe(1)
    expect(metadataValue(reopened, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('0')
    expect(metadataValue(reopened, CODE_INDEX_METADATA_EVIDENCE_EPOCH)).toBe('0')
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0)
    reopened.close()

    // The rebuilt store serves MATCH queries through the new mirror.
    const serving = await openCodeIndexDatabase(path)
    insertIndexedFile(serving, 'src/api.ts')
    serving.prepare(`
      INSERT INTO literal_index (literal_id, file_path, literal, literal_kind, line)
      VALUES ('lit:1', 'src/api.ts', '/api/users', 'route', 3)
    `).run()
    expect((serving.prepare("SELECT literal FROM literal_fts WHERE literal_fts MATCH 'users'").all()))
      .toEqual([{ literal: '/api/users' }])
    serving.close()
  })
})
