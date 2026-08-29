import { describe, expect, it } from 'vitest'
import {
  assertExactAdvance,
  bumpEvidenceEpochOnceInTx,
  bumpIndexEpochOnceInTx,
  readEpochs,
} from '../src/epoch.ts'
import { openCodeIndexDatabase } from '../src/open.ts'
import { writeChunkVectors } from '../src/writer.ts'
import type { ChunkVectorRowInput } from '../src/writer.ts'

/** Build one minimal vector row for the given chunk id. */
function vectorRow(chunkId: string, seed: number): ChunkVectorRowInput {
  const q = Int8Array.from([seed, seed + 1, seed + 2])
  return {
    chunkId,
    chunkRowid: seed,
    model: 'embed-test',
    dim: 3,
    scale: 0.25,
    q: new Uint8Array(q.buffer),
    norm: 2,
  }
}

/** Insert one indexed file plus its chunk rows, bypassing the writer. */
function insertChunks(db: import('node:sqlite').DatabaseSync, filePath: string, chunkIds: readonly string[]): void {
  db.prepare(`
    INSERT INTO files (
      file_path, language, content_hash, mtime, size, is_test_file, indexed_at
    ) VALUES (?, 'typescript', 'hash', 1.5, 10, 0, '2026-08-28T00:00:00Z')
  `).run(filePath)
  for (const chunkId of chunkIds) {
    db.prepare(`
      INSERT INTO chunks (
        chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
      ) VALUES (?, ?, 0, 1, 2, 'export {}', 2)
    `).run(chunkId, filePath)
  }
}

describe('evidence epoch', () => {
  it('advances the evidence clock exactly once per transaction, freezing the index clock', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    const before = readEpochs(db)
    expect(before).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })

    const result = bumpEvidenceEpochOnceInTx(db, () => {
      db.prepare("INSERT INTO metadata (key, value) VALUES ('evidence-scratch', '1')").run()
      return 'vector'
    })
    expect(result).toBe('vector')
    const after = readEpochs(db)
    expect(after).toEqual({ indexEpoch: 0, evidenceEpoch: 1, embeddingEpoch: 0 })
    assertExactAdvance(before, after, 'evidence')
    db.close()
  })

  it('rolls back to the pre-call counter when the unit fails', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(() => bumpEvidenceEpochOnceInTx(db, () => {
      db.prepare("INSERT INTO metadata (key, value) VALUES ('scratch', '1')").run()
      throw new Error('mid-unit failure')
    })).toThrow('mid-unit failure')
    expect(readEpochs(db)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })
    expect((db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key = 'scratch'").get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('counts N committed vector batches as exactly N embedding advances', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunks(db, 'src/a.ts', ['chunk:src/a.ts:0', 'chunk:src/a.ts:1', 'chunk:src/a.ts:2'])

    for (let batch = 0; batch < 3; batch += 1) {
      const before = readEpochs(db)
      writeChunkVectors(db, [vectorRow(`chunk:src/a.ts:${batch}`, batch)])
      const after = readEpochs(db)
      expect(after.embeddingEpoch).toBe((before.embeddingEpoch ?? 0) + 1)
      expect(after.evidenceEpoch).toBe(before.evidenceEpoch)
      expect(after.indexEpoch).toBe(before.indexEpoch)
      assertExactAdvance(before, after, 'embedding')
    }
    expect(readEpochs(db)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 3 })
    db.close()
  })

  it('keeps both channels exclusive: an index write never moves evidence and vice versa', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunks(db, 'src/a.ts', ['chunk:src/a.ts:0'])

    bumpIndexEpochOnceInTx(db, () => {
      db.prepare("INSERT INTO metadata (key, value) VALUES ('index-scratch', '1')").run()
    })
    expect(readEpochs(db)).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })

    writeChunkVectors(db, [vectorRow('chunk:src/a.ts:0', 1)])
    expect(readEpochs(db)).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 1 })
    db.close()
  })

  it('leaves no epoch residue when a vector batch violates a constraint', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    // No chunk rows exist: the foreign key fires and the whole batch — bump
    // included — rolls back.
    expect(() => writeChunkVectors(db, [vectorRow('chunk:none:0', 1)])).toThrow(/FOREIGN KEY/)
    expect(readEpochs(db)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })
    db.close()
  })
})
