import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeIndexError, CODE_INDEX_VECTOR_ROW_INVALID } from '@relay-harness/rlh-code-index'
import {
  CODE_INDEX_SQLITE_SCHEMA_VERSION,
  DERIVED_USER_TABLES,
} from '../src/ddl.ts'
import { readEpochs } from '../src/epoch.ts'
import { openCodeIndexDatabase } from '../src/open.ts'
import { writeChunkVectors } from '../src/writer.ts'
import type { ChunkVectorRowInput } from '../src/writer.ts'

/** One-byte-per-dimension storage contract: build a row from an Int8Array's byte view. */
function vectorRow(chunkId: string, components: readonly number[], model = 'embed-test'): ChunkVectorRowInput {
  const q = Int8Array.from(components)
  return {
    chunkId,
    chunkRowid: Number(chunkId.slice(-1)) + 1,
    model,
    dim: components.length,
    scale: 0.5,
    q: new Uint8Array(q.buffer),
    norm: 3,
  }
}

/** Insert one indexed file plus one chunk, bypassing the writer (direct row shaping). */
function insertChunk(db: import('node:sqlite').DatabaseSync, filePath: string, chunkId: string): void {
  db.prepare(`
    INSERT INTO files (
      file_path, language, content_hash, mtime, size, is_test_file, indexed_at
    ) VALUES (?, 'typescript', 'hash', 1.5, 10, 0, '2026-08-28T00:00:00Z')
  `).run(filePath)
  db.prepare(`
    INSERT INTO chunks (
      chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
    ) VALUES (?, ?, 0, 1, 2, 'export {}', 2)
  `).run(chunkId, filePath)
}

/** Read one chunk's stored components under one model, or `undefined` without a row. */
function storedComponents(
  db: import('node:sqlite').DatabaseSync,
  chunkId: string,
  model: string,
): number[] | undefined {
  const row = db.prepare('SELECT q FROM chunks_vec WHERE chunk_id = ? AND model = ?').get(chunkId, model) as
    | { q: Uint8Array }
    | undefined
  return row === undefined ? undefined : [...Int8Array.from(row.q)]
}

describe('chunks_vec (composite (chunk_id, model) key)', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.()
  })

  it('creates the vector tier inside DERIVED_USER_TABLES with its model index', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(DERIVED_USER_TABLES.has('chunks_vec')).toBe(true)
    expect(DERIVED_USER_TABLES.has('code_embed_jobs')).toBe(true)
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT GLOB 'sqlite_*'",
    ).all() as Array<{ name: string }>).map(row => row.name)
    expect(indexes).toContain('idx_chunks_vec_model')
    expect(indexes).toContain('code_embed_jobs_claim')
    db.close()
  })

  it('stores the byte view exactly and reads back a plain Uint8Array', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    const components = [-127, -1, 0, 1, 127]
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', components)])

    const row = db.prepare(`
      SELECT chunk_rowid, model, dim, format, scale, q, norm
      FROM chunks_vec WHERE chunk_id = 'chunk:src/a.ts:0'
    `).get() as { chunk_rowid: number; model: string; dim: number; format: string; scale: number; q: unknown; norm: number }
    expect(row.model).toBe('embed-test')
    expect(row.dim).toBe(5)
    expect(row.format).toBe('int8')
    expect(row.scale).toBe(0.5)
    expect(row.norm).toBe(3)
    // The BLOB binding contract: Uint8Array in, plain Uint8Array out, byte-equal.
    expect(row.q).toBeInstanceOf(Uint8Array)
    expect(row.q).not.toBeInstanceOf(Buffer)
    const bytes = Int8Array.from(row.q as Uint8Array)
    expect([...bytes]).toEqual(components)
    db.close()
  })

  it('replaces a re-embedded (chunk_id, model) pair instead of duplicating it', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', [1, 2, 3])])
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', [4, 5, 6])])
    const rows = db.prepare('SELECT q FROM chunks_vec').all() as Array<{ q: Uint8Array }>
    expect(rows).toHaveLength(1)
    expect([...Int8Array.from(rows[0]!.q)]).toEqual([4, 5, 6])
    db.close()
  })

  it('coexists two models for one chunk: writes to one never overwrite the other', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', [1, 2, 3], 'model-a')])
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', [9, 9], 'model-b')])
    expect(storedComponents(db, 'chunk:src/a.ts:0', 'model-a')).toEqual([1, 2, 3])
    expect(storedComponents(db, 'chunk:src/a.ts:0', 'model-b')).toEqual([9, 9])

    // Switching back to model-a replaces only model-a's row; model-b survives.
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', [4, 5, 6], 'model-a')])
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n).toBe(2)
    expect(storedComponents(db, 'chunk:src/a.ts:0', 'model-a')).toEqual([4, 5, 6])
    expect(storedComponents(db, 'chunk:src/a.ts:0', 'model-b')).toEqual([9, 9])
    db.close()
  })

  it('refuses a row whose byte view contradicts its dim', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    const mismatched = { ...vectorRow('chunk:src/a.ts:0', [1, 2, 3]), dim: 5 }
    const error = (() => {
      try {
        writeChunkVectors(db, [mismatched])
        return undefined
      } catch (caught: unknown) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(CodeIndexError)
    expect((error as CodeIndexError).code).toBe(CODE_INDEX_VECTOR_ROW_INVALID)
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('enforces STRICT typing, the format CHECK, and the chunks foreign key', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    // A bound JS number carries the REAL storage class and a STRICT BLOB
    // column rejects it outright — the vector column never sees a scalar.
    expect(() => db.prepare(`
      INSERT INTO chunks_vec (chunk_id, chunk_rowid, model, dim, scale, q, norm)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('chunk:src/a.ts:0', 1, 'm', 3, 0.5, 42, 3)).toThrow('cannot store REAL value in BLOB column')
    // An SQL integer literal is typed by syntax (INTEGER), rejected the same way.
    expect(() => db.prepare(`
      INSERT INTO chunks_vec (chunk_id, chunk_rowid, model, dim, scale, q, norm)
      VALUES ('chunk:src/a.ts:0', 1, 'm', 3, 0.5, 42, 3)
    `).run()).toThrow('cannot store INT value in BLOB column')
    // Text in the BLOB column is rejected at the SQL layer too.
    expect(() => db.prepare(`
      INSERT INTO chunks_vec (chunk_id, chunk_rowid, model, dim, scale, q, norm)
      VALUES ('chunk:src/a.ts:0', 1, 'm', 3, 0.5, 'nope', 3)
    `).run()).toThrow('cannot store TEXT value in BLOB column')
    // format is a closed CHECK union.
    expect(() => db.prepare(`
      INSERT INTO chunks_vec (chunk_id, chunk_rowid, model, dim, format, scale, q, norm)
      VALUES ('chunk:src/a.ts:0', 1, 'm', 3, 'f32', 0.5, x'000000', 3)
    `).run()).toThrow(/CHECK/)
    // Unknown chunk id fails loud through the foreign key.
    expect(() => writeChunkVectors(db, [vectorRow('chunk:missing:0', [1])])).toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('cascades vector deletion from its chunk row', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', [1, 2, 3])])
    db.prepare('DELETE FROM chunks WHERE chunk_id = ?').run('chunk:src/a.ts:0')
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('rebuilds a simulated pre-vector store in place up to the current schema, creating the vector tier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlh-code-index-vec-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'index.sqlite')

    const first = await openCodeIndexDatabase(path)
    insertChunk(first, 'src/old.ts', 'chunk:src/old.ts:0')
    first.close()

    // Simulate the previous on-disk medium: same admitted tables minus the
    // vector tier, version pinned at 3. Admission cannot distinguish this from
    // a real v3 file — both read as version mismatch over a registered
    // inventory.
    const v3 = new DatabaseSync(path)
    v3.exec('DROP TABLE chunks_vec')
    v3.exec('DROP TABLE code_embed_jobs')
    v3.exec('DROP INDEX IF EXISTS idx_chunks_vec_model')
    v3.exec('DROP INDEX IF EXISTS code_embed_jobs_claim')
    v3.exec('PRAGMA user_version = 3')
    v3.close()

    const reopened = await openCodeIndexDatabase(path)
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: CODE_INDEX_SQLITE_SCHEMA_VERSION })
    for (const table of ['chunks_vec', 'code_embed_jobs']) {
      expect((reopened.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { n: number }).n).toBe(1)
    }
    // Rebuild is a derived reset: old rows and epochs are gone.
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n).toBe(0)
    expect(readEpochs(reopened)).toEqual({ indexEpoch: 0, evidenceEpoch: 0 })
    reopened.close()
  })

  it('rebuilds a simulated v4 store in place up to v5, replacing the single-column chunks_vec key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlh-code-index-vec-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'index.sqlite')

    const first = await openCodeIndexDatabase(path)
    insertChunk(first, 'src/old.ts', 'chunk:src/old.ts:0')
    first.close()

    // Hand-craft the v4 medium: the vector tier exists but chunks_vec is keyed
    // by chunk_id alone, so two models could not coexist for one chunk. The
    // version pin alone is enough for admission to order a rebuild.
    const v4 = new DatabaseSync(path)
    v4.exec('DROP TABLE chunks_vec')
    v4.exec(`
      CREATE TABLE chunks_vec (
        chunk_id    TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        chunk_rowid INTEGER NOT NULL,
        model       TEXT NOT NULL,
        dim         INTEGER NOT NULL,
        format      TEXT NOT NULL DEFAULT 'int8' CHECK (format = 'int8'),
        scale       REAL NOT NULL,
        q           BLOB NOT NULL,
        norm        REAL NOT NULL
      ) STRICT
    `)
    v4.exec('PRAGMA user_version = 4')
    v4.close()

    const reopened = await openCodeIndexDatabase(path)
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: CODE_INDEX_SQLITE_SCHEMA_VERSION })
    const ddl = (reopened.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
    ).get() as { sql: string }).sql
    expect(ddl).toContain('PRIMARY KEY (chunk_id, model)')
    reopened.close()
  })
})
