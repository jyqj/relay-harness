import { describe, expect, it } from 'vitest'
import {
  CODE_INDEX_METADATA_EVIDENCE_EPOCH,
  CODE_INDEX_METADATA_INDEX_EPOCH,
  CODE_INDEX_SQLITE_APPLICATION_ID,
  CODE_INDEX_SQLITE_SCHEMA_VERSION,
  DERIVED_USER_TABLES,
  ensureCodeIndexSchema,
} from '../src/ddl.ts'
import { openCodeIndexDatabase } from '../src/open.ts'

function readMetadata(db: import('node:sqlite').DatabaseSync, key: string): string | undefined {
  return (db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

describe('code-index SQLite DDL', () => {
  it('creates the derived schema on an in-memory database and reseeds epoch metadata only when missing', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(pragmaNumber(db, 'application_id')).toBe(CODE_INDEX_SQLITE_APPLICATION_ID)
    expect(pragmaNumber(db, 'user_version')).toBe(CODE_INDEX_SQLITE_SCHEMA_VERSION)
    expect(readMetadata(db, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('0')
    expect(readMetadata(db, CODE_INDEX_METADATA_EVIDENCE_EPOCH)).toBe('0')

    db.prepare(`
      INSERT INTO files (
        file_path, language, content_hash, mtime, size, is_test_file, indexed_at
      ) VALUES ('src/a.ts', 'typescript', 'hash-a', 1.5, 10, 0, '2026-08-27T00:00:00Z')
    `).run()
    db.prepare(`
      INSERT INTO chunks (
        chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
      ) VALUES ('chunk:src/a.ts:0', 'src/a.ts', 0, 1, 2, 'export {}', 2)
    `).run()

    // Re-running every DDL statement is a no-op on an admitted database.
    ensureCodeIndexSchema(db)
    expect(readMetadata(db, CODE_INDEX_METADATA_INDEX_EPOCH)).toBe('0')
    expect((db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(1)

    const indexes = tableNames(db, 'index')
    expect(indexes).toContain('idx_chunks_file')
    expect(indexes).toContain('idx_chunks_symbol')
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_symbols_name',
      'idx_symbols_file',
      'idx_symbols_qname',
      'idx_symbols_uid',
      'idx_imports_resolved',
      'idx_ce_caller_uid',
      'idx_ce_callee_uid',
      'idx_ce_file_line',
    ]))
    expect(tableNames(db, 'trigger').sort()).toEqual([
      'file_paths_fts_ad',
      'file_paths_fts_ai',
      'file_paths_fts_au',
      'literal_fts_ad',
      'literal_fts_ai',
      'literal_fts_au',
      'symbols_fts_ad',
      'symbols_fts_ai',
      'symbols_fts_au',
    ])
    for (const name of DERIVED_USER_TABLES) {
      expect(tableNames(db, 'table')).toContain(name)
    }
    db.close()
  })

  it('enforces STRICT typing on files and chunks columns', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(() => db.prepare(`
      INSERT INTO files (
        file_path, language, content_hash, mtime, size, is_test_file, indexed_at
      ) VALUES ('src/bad.ts', 'typescript', 'hash-b', 'not-a-number', 10, 0, '2026-08-27T00:00:00Z')
    `).run()).toThrow(/mtime/i)
    expect(() => db.prepare(`
      INSERT INTO chunks (
        chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
      ) VALUES ('chunk:x:0', 'src/missing.ts', 0, 'one', 2, 'body', 1)
    `).run()).toThrow()
    db.close()
  })

  it('cascades chunk deletion from its file and keeps FTS trigger bookkeeping consistent', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertIndexedFile(db, 'src/c.ts')
    insertIndexedFile(db, 'src/d.ts')
    expect((db.prepare('SELECT COUNT(*) AS n FROM file_paths_fts').get() as { n: number }).n).toBe(2)

    // Deleting a file removes its chunks through the foreign key and its
    // trigram path entries through the AFTER DELETE trigger.
    db.prepare('DELETE FROM files WHERE file_path = ?').run('src/d.ts')
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT * FROM file_paths_fts WHERE file_path = 'src/d.ts'").all()).length).toBe(0)
    expect((db.prepare("SELECT * FROM file_paths_fts WHERE file_path = 'src/c.ts'").all()).length).toBe(1)
    db.close()
  })

  it('enforces STRICT typing on the graph tables', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertIndexedFile(db, 'src/graph.ts')
    expect(() => db.prepare(`
      INSERT INTO symbols (
        symbol_id, file_path, name, kind, start_line, end_line, symbol_uid
      ) VALUES ('sym:1', 'src/graph.ts', 'fn', 'function', 'ten', 20, 'uid:1')
    `).run()).toThrow(/start_line/i)
    expect(() => db.prepare(`
      INSERT INTO imports (
        file_path, import_string, is_namespace
      ) VALUES ('src/graph.ts', './x', 'yes')
    `).run()).toThrow()
    expect(() => db.prepare(`
      INSERT INTO call_edges (
        edge_id, file_path, is_optional_chain
      ) VALUES ('edge:1', 'src/graph.ts', 1.5)
    `).run()).toThrow()
    expect(() => db.prepare(`
      INSERT INTO test_edges (edge_id, test_file_path, code_file_path, confidence)
      VALUES ('tedge:1', 'a.spec.ts', 'a.ts', 'high')
    `).run()).toThrow()
    expect(() => db.prepare(`
      INSERT INTO literal_index (
        literal_id, file_path, literal
      ) VALUES ('lit:1', 'src/missing.ts', 'x')
    `).run()).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare(`
      INSERT INTO symbol_refs (
        ref_id, file_path, target_symbol_uid
      ) VALUES ('ref:1', 'src/missing.ts', 'uid:x')
    `).run()).toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('keeps literal_fts aligned with literal_index through its triggers and file deletion', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertIndexedFile(db, 'src/keep.ts')
    insertIndexedFile(db, 'src/drop.ts')
    const insertLiteral = (filePath: string, literalId: string, literal: string | null, kind: string | null): void => {
      db.prepare(`
        INSERT INTO literal_index (
          literal_id, file_path, literal, literal_kind, line, container
        ) VALUES (?, ?, ?, ?, 7, 'buildUrl')
      `).run(literalId, filePath, literal, kind)
    }
    insertLiteral('src/keep.ts', 'lit:route', '/api/users/login', 'route')
    // Nullable mirrored columns coalesce to '' so FTS5 accepts the row.
    insertLiteral('src/drop.ts', 'lit:null', null, null)
    expect((db.prepare('SELECT COUNT(*) AS n FROM literal_fts').get() as { n: number }).n).toBe(2)

    // The UPDATE trigger swaps the mirror row in place.
    db.prepare("UPDATE literal_index SET literal = ? WHERE literal_id = 'lit:route'").run('/api/v2/login')
    expect(db.prepare('SELECT literal FROM literal_fts').all()).toEqual([
      { literal: '/api/v2/login' },
      { literal: '' },
    ])

    // Deleting the files row cascades the literal_index delete and its mirror.
    db.prepare('DELETE FROM files WHERE file_path = ?').run('src/drop.ts')
    expect((db.prepare('SELECT COUNT(*) AS n FROM literal_index').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM literal_fts').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('keeps symbols_fts aligned with symbols through its triggers and file deletion', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertIndexedFile(db, 'src/keep.ts')
    insertIndexedFile(db, 'src/drop.ts')
    for (const [filePath, name, uid] of [
      ['src/keep.ts', 'keeper', 'uid:keeper'],
      ['src/drop.ts', 'dropper', 'uid:dropper'],
    ] as const) {
      db.prepare(`
        INSERT INTO symbols (
          symbol_id, file_path, name, kind, start_line, end_line, symbol_uid
        ) VALUES (?, ?, ?, 'function', 1, 2, ?)
      `).run(`sym:${name}`, filePath, name, uid)
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n: number }).n).toBe(2)
    // The UPDATE trigger swaps the mirror row in place.
    db.prepare("UPDATE symbols SET name = 'renamed' WHERE symbol_uid = 'uid:keeper'").run()
    expect(db.prepare('SELECT name FROM symbols_fts').all()).toEqual([{ name: 'renamed' }, { name: 'dropper' }])

    // Deleting the files row cascades the symbols delete; the AFTER DELETE
    // trigger removes the mirror row — and a second explicit symbols delete
    // for the same path must stay a harmless no-op, never a double delete.
    db.prepare('DELETE FROM symbols WHERE file_path = ?').run('src/drop.ts')
    db.prepare('DELETE FROM files WHERE file_path = ?').run('src/drop.ts')
    expect((db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n: number }).n).toBe(1)
    expect(db.prepare('SELECT name FROM symbols_fts').all()).toEqual([{ name: 'renamed' }])
    db.close()
  })
})

function insertIndexedFile(db: import('node:sqlite').DatabaseSync, filePath: string): void {
  db.prepare(`
    INSERT INTO files (
      file_path, language, content_hash, mtime, size, is_test_file, indexed_at
    ) VALUES (?, 'typescript', 'hash', 1.5, 10, 0, '2026-08-27T00:00:00Z')
  `).run(filePath)
  db.prepare(`
    INSERT INTO chunks (
      chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
    ) VALUES (?, ?, 0, 1, 2, 'export {}', 2)
  `).run(`chunk:${filePath}:0`, filePath)
}

function pragmaNumber(db: import('node:sqlite').DatabaseSync, name: 'application_id' | 'user_version'): number {
  return (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name] as number
}

function tableNames(db: import('node:sqlite').DatabaseSync, kind: 'table' | 'index' | 'trigger'): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT GLOB 'sqlite_*'",
  ).all(kind) as Array<{ name: string }>).map(row => row.name)
}
