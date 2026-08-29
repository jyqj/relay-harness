/** Independent vector recall through the SQLite exact-scan adapter and normal RRF engine path. */

import { describe, expect, it } from 'vitest'
import { createSearchEngine, createVectorLane, quantizeInt8 } from '@relay-harness/rlh-code-index-search'
import { openCodeIndexDatabase } from '../src/open.ts'
import { createRetrievalPort } from '../src/reader.ts'
import { writeChunkVectors, writeFilesDelta } from '../src/writer.ts'

function file(filePath: string, text: string) {
  return {
    filePath,
    language: 'typescript',
    contentHash: `hash-${filePath}`,
    mtime: 1,
    size: text.length,
    summary: text,
    contentExcerpt: text,
    parserTier: 'generic' as const,
    parserConfidence: 0.5,
    isTestFile: false,
    chunks: [{
      chunkId: `chunk:${filePath}:0`,
      chunkIndex: 0,
      startLine: 1,
      endLine: 1,
      breadcrumb: '',
      symbolName: null,
      symbolKind: null,
      text,
      tokenEstimate: 4,
    }],
  }
}

function vectorRow(chunkId: string, rowid: number, values: readonly number[]) {
  const quantized = quantizeInt8(Float32Array.from(values))
  return {
    chunkId,
    chunkRowid: rowid,
    model: 'semantic-generation',
    dim: values.length,
    scale: quantized.scale,
    q: new Uint8Array(quantized.q.buffer),
    norm: quantized.norm,
  }
}

describe('independent vector recall', () => {
  it('admits a semantic-only candidate through the vector lane and normal RRF reasons/score trace', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    writeFilesDelta(db, { removals: [], upserts: [
      file('src/semantic.ts', 'words with no query token overlap'),
      file('src/opposite.ts', 'unrelated opposite direction'),
    ] })
    const port = createRetrievalPort(db)
    const rowids = new Map((db.prepare('SELECT chunk_id, rowid FROM chunks').all() as Array<{
      chunk_id: string
      rowid: number
    }>).map(row => [row.chunk_id, row.rowid]))
    writeChunkVectors(db, [
      vectorRow('chunk:src/semantic.ts:0', rowids.get('chunk:src/semantic.ts:0')!, [1, 0, 0]),
      vectorRow('chunk:src/opposite.ts:0', rowids.get('chunk:src/opposite.ts:0')!, [-1, 0, 0]),
    ])
    const engine = createSearchEngine({
      port,
      lanes: [createVectorLane({ generationId: 'legacy-model:semantic-generation' })],
    })
    const result = engine.search({ query: 'lexically absent needle', queryVector: Float32Array.from([1, 0, 0]) })
    expect(result.hits.map(hit => hit.filePath)).toEqual(['src/semantic.ts'])
    expect(result.hits[0]?.reasons).toContain('vector@1')
    expect(result.hits[0]?.scoreTrace.some(component => component.label === 'rrf:vector')).toBe(true)
    db.close()
  })

  it('applies path scope inside the adapter and reports bounded exact-scan truncation', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    writeFilesDelta(db, { removals: [], upserts: [
      file('a/one.ts', 'one'),
      file('b/two.ts', 'two'),
      file('b/three.ts', 'three'),
    ] })
    const port = createRetrievalPort(db)
    const details = db.prepare('SELECT chunk_id AS chunkId, rowid FROM chunks ORDER BY chunk_id').all() as Array<{
      chunkId: string
      rowid: number
    }>
    writeChunkVectors(db, details.map((row, index) => vectorRow(row.chunkId, row.rowid, [1, index / 10 + 0.1])))
    const vector = port.vector!
    const scoped = vector.recallCandidates!({
      generationId: 'legacy-model:semantic-generation',
      queryVector: Float32Array.from([1, 0]),
      scope: { pathPrefix: 'b/', filePaths: null, languages: null },
      topK: 5,
      maxScan: 1,
    })
    expect(scoped.scanned).toBe(1)
    expect(scoped.truncated).toBe(true)
    expect(scoped.hits.every(hit => hit.chunkId.startsWith('chunk:b/'))).toBe(true)
    db.close()
  })
})
