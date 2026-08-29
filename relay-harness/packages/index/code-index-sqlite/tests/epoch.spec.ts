import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeIndexError } from '@relay-harness/rlh-code-index'
import {
  CODE_INDEX_METADATA_EVIDENCE_EPOCH,
  CODE_INDEX_METADATA_INDEX_EPOCH,
} from '../src/ddl.ts'
import { assertExactAdvance, bumpIndexEpochOnceInTx, readEpochs } from '../src/epoch.ts'
import { openCodeIndexDatabase } from '../src/open.ts'
import { writeFilesDelta } from '../src/writer.ts'
import { clock, fileUpsert } from './support.ts'

describe('epoch clocks', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.()
  })

  it('advances the index epoch exactly once per committed write transaction', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    const before = readEpochs(db)
    expect(before).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })

    const result = bumpIndexEpochOnceInTx(db, () => {
      for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
        db.prepare(`
          INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at)
          VALUES (?, 'typescript', 'h', 1, 1, '2026-08-27T00:00:00Z')
        `).run(path)
      }
      return 42
    })
    expect(result).toBe(42)

    const after = readEpochs(db)
    expect(after).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })
    assertExactAdvance(before, after, 'index')
    db.close()
  })

  it('rolls back to the pre-call counter when a unit fails', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(() => bumpIndexEpochOnceInTx(db, () => {
      db.prepare("INSERT INTO metadata (key, value) VALUES ('scratch', '1')").run()
      throw new Error('mid-unit failure')
    })).toThrow('mid-unit failure')
    expect(readEpochs(db)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })
    expect((db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key = 'scratch'").get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('continues the counters across close/reopen and a derived rebuild resets them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlh-code-index-epoch-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'index.sqlite')

    const first = await openCodeIndexDatabase(path)
    writeFilesDelta(
      first,
      { removals: [], upserts: [fileUpsert('src/a.ts', ['export const a = 1'])] },
      { now: clock() },
    )
    expect(readEpochs(first)).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })
    first.close()

    // Reopening preserves committed epochs; the next commit continues them.
    const reopened = await openCodeIndexDatabase(path)
    writeFilesDelta(reopened, { removals: ['src/a.ts'], upserts: [] }, { now: clock() })
    expect(readEpochs(reopened)).toEqual({ indexEpoch: 2, evidenceEpoch: 0, embeddingEpoch: 0 })
    reopened.close()

    // An unregistered table under our id forces the in-place rebuild.
    const drifted = await openCodeIndexDatabase(path)
    expect(readEpochs(drifted)).toEqual({ indexEpoch: 2, evidenceEpoch: 0, embeddingEpoch: 0 })
    drifted.exec('CREATE TABLE rogue_unused (x TEXT)')
    drifted.close()
    const afterRebuild = await openCodeIndexDatabase(path)
    expect(readEpochs(afterRebuild)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })
    expect((afterRebuild.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0)
    afterRebuild.close()
  })

  it('refuses to guess when seeded metadata rows are missing or unparsable', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    db.prepare('DELETE FROM metadata WHERE key = ?').run(CODE_INDEX_METADATA_INDEX_EPOCH)
    expect(() => readEpochs(db)).toThrow(CodeIndexError)
    expect(() => readEpochs(db)).toThrow(/seeded "index_epoch"/)

    // Restore the index row, then exercise the evidence-side failures.
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(CODE_INDEX_METADATA_INDEX_EPOCH, '0')
    for (const bad of ['', '1.5', 'not-a-number', '-2']) {
      db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(bad, CODE_INDEX_METADATA_EVIDENCE_EPOCH)
      expect(() => readEpochs(db)).toThrow(CodeIndexError)
      expect(() => readEpochs(db)).toThrow(/evidence_epoch/)
    }
    db.close()
  })

  it('audits exact single-advance per channel and rejects every other shape', async () => {
    expect(() => { assertExactAdvance(
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 5, evidenceEpoch: 9, embeddingEpoch: 0 },
      'index',
    ) }).not.toThrow()
    expect(() => { assertExactAdvance(
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 4, evidenceEpoch: 10, embeddingEpoch: 0 },
      'evidence',
    ) }).not.toThrow()

    // Declared channel advanced by zero or more than one.
    expect(() => { assertExactAdvance(
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      'index',
    ) }).toThrow(CodeIndexError)
    expect(() => { assertExactAdvance(
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 6, evidenceEpoch: 9, embeddingEpoch: 0 },
      'index',
    ) }).toThrow(/exactly once/)
    expect(() => { assertExactAdvance(
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 5, evidenceEpoch: 8, embeddingEpoch: 0 },
      'evidence',
    ) }).toThrow(CodeIndexError)

    // The frozen sibling moved.
    expect(() => { assertExactAdvance(
      { indexEpoch: 4, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 5, evidenceEpoch: 12, embeddingEpoch: 0 },
      'index',
    ) }).toThrow(/frozen evidenceEpoch counter/)
    expect(() => { assertExactAdvance(
      { indexEpoch: 7, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 8, evidenceEpoch: 10, embeddingEpoch: 0 },
      'evidence',
    ) }).toThrow(/frozen indexEpoch counter/)
    expect(() => { assertExactAdvance(
      { indexEpoch: 7, evidenceEpoch: 9, embeddingEpoch: 0 },
      { indexEpoch: 7, evidenceEpoch: 10, embeddingEpoch: 0 },
      'evidence',
    ) }).not.toThrow()
  })
})
