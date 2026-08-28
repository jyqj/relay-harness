/**
 * The seam's `dead_code` explore op: the scan-limit formula, the phase-1
 * exclusion filters and reverse-lookup eliminations over a real store, the
 * output cap with its `result_limit` truncation token, and the provider
 * wiring that reports a genuinely uncalled fixture symbol.
 *
 * The reference implementation excludes no TEST FILES from the scan — its
 * only test-ish exclusions are symbol-NAME prefixes (`test_*`, `Test*`),
 * which these tests pin.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createRetrievalPort, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import {
  DEAD_CODE_DECLARED,
  DEAD_CODE_REASON,
  DEAD_CODE_SCAN_FACTOR,
  DEAD_CODE_SCAN_MAX,
  deadCodeAnswer,
  deadCodeScanLimit,
  DEFAULT_MAX_DEAD_CODE,
} from '../src/dead-code.ts'
import type { ExploreGraphInput } from '../src/explore.ts'
import { openStore } from '../src/indexer.ts'
import { LocalCodeIndexRuntime } from '../src/provider.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

describe('deadCodeScanLimit', () => {
  it('multiplies the cap by 40 and clamps at 5000', () => {
    expect(deadCodeScanLimit(0)).toBe(0)
    expect(deadCodeScanLimit(1)).toBe(40)
    expect(deadCodeScanLimit(50)).toBe(2000)
    expect(deadCodeScanLimit(125)).toBe(5000)
    expect(deadCodeScanLimit(200)).toBe(5000)
    expect(DEAD_CODE_SCAN_FACTOR).toBe(40)
    expect(DEAD_CODE_SCAN_MAX).toBe(5000)
    expect(DEFAULT_MAX_DEAD_CODE).toBe(50)
  })
})

/** Symbol rows with a caller edge, ref rows, or neither, in one store. */
async function deadCodeStore(): Promise<{ db: DatabaseSync; facet: ExploreGraphInput['facet'] }> {
  const store = await openStore(':memory:', 'wal')
  const db = store.db
  for (const path of ['src/dead.ts', 'src/live.ts']) {
    db.prepare(
      'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(path, 'typescript', `hash-${path}`, 1, 10, '2026-01-01')
  }
  const insertSymbol = db.prepare(
    'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, symbol_uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const seed = (name: string, uid: string | null): void => {
    insertSymbol.run(`sym:${name}`, 'src/dead.ts', name, 'function', 1, 2, uid)
  }
  seed('calledFn', 'uid:calledFn')
  seed('selfLoopFn', 'uid:selfLoopFn')
  seed('externallyRefdFn', 'uid:externallyRefdFn')
  seed('selfRefdFn', 'uid:selfRefdFn')
  seed('orphanFn', 'uid:orphanFn')
  seed('main', 'uid:main')
  seed('configure', 'uid:configure')
  seed('test_helperFn', 'uid:test_helperFn')
  seed('TestSetupFn', 'uid:TestSetupFn')
  seed('anonymousBlock', null)
  seed('liveFn', 'uid:liveFn')

  const insertEdge = db.prepare(
    'INSERT INTO call_edges (edge_id, file_path, caller_symbol_uid, callee_symbol_uid, line) VALUES (?, ?, ?, ?, ?)',
  )
  // A real caller keeps calledFn alive; a self-loop does NOT count as a
  // caller for selfLoopFn; an UNBOUND caller still counts as one for liveFn.
  insertEdge.run('e1', 'src/live.ts', 'uid:orphanFn', 'uid:calledFn', 4)
  insertEdge.run('e2', 'src/dead.ts', 'uid:selfLoopFn', 'uid:selfLoopFn', 1)
  insertEdge.run('e3', 'src/live.ts', null, 'uid:liveFn', 5)

  const insertRef = db.prepare(
    'INSERT INTO symbol_refs (ref_id, file_path, container, target_symbol_uid, line) VALUES (?, ?, ?, ?, ?)',
  )
  // An external container marks the reference external; a container equal to
  // the symbol's own name is a self-reference and keeps the candidate.
  insertRef.run('r1', 'src/live.ts', 'someoneElse', 'uid:externallyRefdFn', 2)
  insertRef.run('r2', 'src/dead.ts', 'selfRefdFn', 'uid:selfRefdFn', 3)
  return { db, facet: createRetrievalPort(db).graph }
}

function inputFor(facet: ExploreGraphInput['facet'], db: DatabaseSync): ExploreGraphInput {
  return {
    request: { op: 'dead_code' },
    facet,
    limits: { maxResolve: 3, callersPerSym: 2, calleesPerSym: 2, maxTests: 2, maxRoutes: 1, graphBudgetPct: 20 },
    tier: 'tiny',
    epochs: readEpochs(db),
  }
}

describe('deadCodeAnswer over a store', () => {
  it('keeps only symbols with no non-self callers and no external references', async () => {
    const { db, facet } = await deadCodeStore()
    const answer = deadCodeAnswer(inputFor(facet, db), { op: 'dead_code', max: 50 })
    expect(answer.op).toBe('dead_code')
    expect(answer.explain.declared).toEqual(DEAD_CODE_DECLARED)
    expect(answer.nodes).toEqual([])
    expect(answer.edges).toEqual([])
    expect(answer.truncated).toBe(false)
    expect(answer.explain.truncatedReason).toBeUndefined()
    // Eliminated: calledFn (caller), liveFn (unbound caller), externallyRefdFn
    // (external reference), main/configure (entry-point names),
    // test_helperFn/TestSetupFn (test-ish name prefixes), anonymousBlock
    // (no uid). Survivors: the self-loop, the self-referenced, and the truly
    // unreferenced.
    expect(answer.deadCode).toEqual([
      { symbolName: 'selfLoopFn', symbolId: 'uid:selfLoopFn', filePath: 'src/dead.ts', kind: 'function', reason: DEAD_CODE_REASON },
      { symbolName: 'selfRefdFn', symbolId: 'uid:selfRefdFn', filePath: 'src/dead.ts', kind: 'function', reason: DEAD_CODE_REASON },
      { symbolName: 'orphanFn', symbolId: 'uid:orphanFn', filePath: 'src/dead.ts', kind: 'function', reason: DEAD_CODE_REASON },
    ])
    expect(answer.candidateCount).toBe(3)
    expect(answer.indexEpoch).toEqual(readEpochs(db))
  })

  it('cuts the candidate list to the cap after the filters and records result_limit', async () => {
    const { db, facet } = await deadCodeStore()
    const answer = deadCodeAnswer(inputFor(facet, db), { op: 'dead_code', max: 2 })
    expect(answer.deadCode).toHaveLength(2)
    expect(answer.candidateCount).toBe(3)
    expect(answer.truncated).toBe(true)
    expect(answer.explain.truncatedReason).toBe('result_limit')
  })

  it('answers an empty store with an empty, untruncated list', async () => {
    const store = await openStore(':memory:', 'wal')
    const answer = deadCodeAnswer(inputFor(createRetrievalPort(store.db).graph, store.db), { op: 'dead_code' })
    expect(answer.deadCode).toEqual([])
    expect(answer.candidateCount).toBe(0)
    expect(answer.truncated).toBe(false)
  })
})

describe('provider wiring', () => {
  it('reports a genuinely uncalled fixture symbol and spares the called chain', async () => {
    const files = {
      'src/engine.ts': 'export function spoolQuantaMarker(): number {\n  return 1\n}\n',
      'src/pump.ts': "import { spoolQuantaMarker } from './engine'\n\nexport function pumpCycle(): number {\n  return spoolQuantaMarker()\n}\n",
      'src/drain.ts': "import { pumpCycle } from './pump'\n\nexport function drainAll(): number {\n  return pumpCycle()\n}\n",
    }
    const root = await makeWorkspace('rlh-dead-code-runtime-', { files })
    const runtime = new LocalCodeIndexRuntime({
      workspaceRoot: root,
      databasePath: ':memory:',
      journalMode: 'wal',
      excludePatterns: [],
      maxFileBytes: 512_000,
    })
    try {
      const answer = await runtime.exploreGraph({ op: 'dead_code' })
      expect(answer.op).toBe('dead_code')
      expect(answer.truncated).toBe(false)
      // drainAll calls pumpCycle but nothing calls drainAll, and nothing
      // references it from outside its own declaration.
      expect(answer.deadCode?.map(item => item.symbolName)).toEqual(['drainAll'])
      const item = answer.deadCode?.[0]
      expect(typeof item?.symbolId).toBe('string')
      expect(item).toMatchObject({
        filePath: 'src/drain.ts',
        kind: 'function',
        reason: 'no-callers',
      })
    } finally {
      await runtime.dispose()
    }
  })
})
