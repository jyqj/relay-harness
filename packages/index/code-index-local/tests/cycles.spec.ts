/**
 * The seam's `cycles` explore op: the iterative Tarjan SCC pass (pure unit
 * contracts), the answer assembly over a real store's import adjacency
 * (ordering, severity, witnesses, cap truncation), and the provider wiring
 * that detects a real two-file import cycle through the parsed graph.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createRetrievalPort, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import { compareStrings } from '@relay-harness/rlh-code-index-search'
import { openStore } from '../src/indexer.ts'
import { CYCLES_DECLARED, cycleSeverity, cyclesAnswer, tarjanScc } from '../src/cycles.ts'
import type { ExploreGraphInput } from '../src/explore.ts'
import { LocalCodeIndexRuntime } from '../src/provider.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

/** Adjacency from entries, so unit tests read like the cc Tarjan table tests. */
function adjacencyOf(entries: ReadonlyArray<readonly [string, ...string[]]>): Map<string, string[]> {
  return new Map(entries.map(([node, ...targets]) => [node, [...targets]]))
}

describe('tarjanScc', () => {
  it('finds a simple three-node cycle', () => {
    const sccs = tarjanScc(adjacencyOf([['a', 'b'], ['b', 'c'], ['c', 'a']]))
    expect(sccs).toHaveLength(1)
    expect([...sccs[0] as string[]].sort(compareStrings)).toEqual(['a', 'b', 'c'])
  })

  it('returns nothing for a DAG and for a bare adjacency', () => {
    expect(tarjanScc(adjacencyOf([['a', 'b'], ['b', 'c']]))).toEqual([])
    expect(tarjanScc(new Map())).toEqual([])
  })

  it('excludes self-loops as size-1 components', () => {
    expect(tarjanScc(adjacencyOf([['a', 'a']]))).toEqual([])
  })

  it('finds two separate cycles of sizes 2 and 3', () => {
    const sccs = tarjanScc(adjacencyOf([
      ['a', 'b'], ['b', 'a'],
      ['c', 'd'], ['d', 'e'], ['e', 'c'],
    ]))
    expect(sccs).toHaveLength(2)
    expect(sccs.map(component => component.length).sort((a, b) => a - b)).toEqual([2, 3])
  })

  it('keeps nodes that appear only as targets in the graph', () => {
    // b is never a key: a → b must still form a size-1 SCC (filtered) with b
    // present in the walk, and a lone target must not crash the pass.
    expect(tarjanScc(adjacencyOf([['a', 'b']]))).toEqual([])
  })

  it('finds nested cycles inside one larger graph', () => {
    const sccs = tarjanScc(adjacencyOf([
      ['1', '2'], ['2', '3'], ['3', '1', '4'], ['4', '5'], ['5', '4', '6'],
    ]))
    expect(sccs).toHaveLength(2)
    const sorted = sccs
      .map(component => [...component].sort(compareStrings))
      .sort((left, right) => left.length - right.length)
    expect(sorted[0]).toEqual(['4', '5'])
    expect(sorted[1]).toEqual(['1', '2', '3'])
  })

  it('propagates lowlinks through chains so cross-linked cycles merge', () => {
    // a ↔ b plus b → c → b: one shared component of size 3.
    const sccs = tarjanScc(adjacencyOf([['a', 'b'], ['b', 'a', 'c'], ['c', 'b']]))
    expect(sccs).toHaveLength(1)
    expect([...sccs[0] as string[]].sort(compareStrings)).toEqual(['a', 'b', 'c'])
  })
})

describe('cycleSeverity', () => {
  it('classifies by member count', () => {
    expect(cycleSeverity(2)).toBe('low')
    expect(cycleSeverity(3)).toBe('medium')
    expect(cycleSeverity(4)).toBe('medium')
    expect(cycleSeverity(5)).toBe('high')
    expect(cycleSeverity(9)).toBe('high')
  })
})

/** Build a store whose import graph is exactly the given edge list. */
async function importStore(
  edges: ReadonlyArray<readonly [string, string] | readonly [string, string, string]>,
): Promise<{ db: DatabaseSync; facet: ExploreGraphInput['facet'] }> {
  const store = await openStore(':memory:', 'wal')
  const db = store.db
  const paths = [...new Set(edges.flatMap(edge => [edge[0], edge[1]]))].sort(compareStrings)
  for (const path of paths) {
    db.prepare(
      'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(path, 'typescript', `hash-${path}`, 1, 10, '2026-01-01')
  }
  for (const [from, to, importString] of edges) {
    db.prepare(
      'INSERT INTO imports (file_path, import_string, resolved_path, imported_name, alias, is_namespace, is_default, is_reexport) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(from, importString ?? `./${to}`, to, null, null, 0, 0, 0)
  }
  return { db, facet: createRetrievalPort(db).graph }
}

function inputFor(facet: ExploreGraphInput['facet'], epochs = { indexEpoch: 1, evidenceEpoch: 0 }): ExploreGraphInput {
  return {
    request: { op: 'cycles' },
    facet,
    limits: { maxResolve: 3, callersPerSym: 2, calleesPerSym: 2, maxTests: 2, maxRoutes: 1, graphBudgetPct: 20 },
    tier: 'tiny',
    epochs,
  }
}

describe('cyclesAnswer over a store', () => {
  it('reports components largest first with severity, sorted members, and witnesses', async () => {
    const { db, facet } = await importStore([
      // 5-cycle: a → b → c → d → e → a
      ['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/c.ts'], ['src/c.ts', 'src/d.ts'],
      ['src/d.ts', 'src/e.ts'], ['src/e.ts', 'src/a.ts'],
      // 2-cycle: x ↔ y
      ['src/x.ts', 'src/y.ts'], ['src/y.ts', 'src/x.ts'],
      // DAG tails must not create components
      ['src/z.ts', 'src/a.ts'],
    ])
    const answer = cyclesAnswer(inputFor(facet, readEpochs(db)), { op: 'cycles' })
    expect(answer.op).toBe('cycles')
    expect(answer.explain.declared).toEqual(CYCLES_DECLARED)
    expect(answer.nodes).toEqual([])
    expect(answer.edges).toEqual([])
    expect(answer.candidateCount).toBe(2)
    expect(answer.truncated).toBe(false)
    expect(answer.cycles).toEqual([
      {
        id: 'cycle:1',
        size: 5,
        severity: 'high',
        memberIds: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
        witnessEdges: [
          { from: 'src/a.ts', to: 'src/b.ts', importString: './src/b.ts' },
          { from: 'src/b.ts', to: 'src/c.ts', importString: './src/c.ts' },
          { from: 'src/c.ts', to: 'src/d.ts', importString: './src/d.ts' },
          { from: 'src/d.ts', to: 'src/e.ts', importString: './src/e.ts' },
          { from: 'src/e.ts', to: 'src/a.ts', importString: './src/a.ts' },
        ],
      },
      {
        id: 'cycle:2',
        size: 2,
        severity: 'low',
        memberIds: ['src/x.ts', 'src/y.ts'],
        witnessEdges: [
          { from: 'src/x.ts', to: 'src/y.ts', importString: './src/y.ts' },
          { from: 'src/y.ts', to: 'src/x.ts', importString: './src/x.ts' },
        ],
      },
    ])
  })

  it('orders by size descending BEFORE the cap cuts and records result_limit', async () => {
    const { facet } = await importStore([
      ['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/c.ts'], ['src/c.ts', 'src/a.ts'],
      ['src/x.ts', 'src/y.ts'], ['src/y.ts', 'src/x.ts'],
    ])
    const answer = cyclesAnswer(inputFor(facet), { op: 'cycles', max: 1 })
    expect(answer.candidateCount).toBe(2)
    expect(answer.truncated).toBe(true)
    expect(answer.explain.truncatedReason).toBe('result_limit')
    expect(answer.cycles?.map(component => component.size)).toEqual([3])
    expect(answer.cycles?.[0]?.severity).toBe('medium')
  })

  it('answers an acyclic or empty graph with an empty, untruncated answer', async () => {
    const { db, facet } = await importStore([['src/a.ts', 'src/b.ts']])
    const answer = cyclesAnswer(inputFor(facet, readEpochs(db)), { op: 'cycles' })
    expect(answer.cycles).toEqual([])
    expect(answer.candidateCount).toBe(0)
    expect(answer.truncated).toBe(false)
    expect(answer.explain.truncatedReason).toBeUndefined()
    expect(answer.indexEpoch).toEqual(readEpochs(db))
  })

  it('breaks size ties on the sorted member list and deduplicates parallel witnesses per file pair', async () => {
    const { db, facet } = await importStore([
      // Two same-size components: tie-break orders by sorted member list, so
      // the p/q cycle renders before the x/y cycle.
      ['src/q.ts', 'src/p.ts'], ['src/p.ts', 'src/q.ts'],
      ['src/y.ts', 'src/x.ts'], ['src/x.ts', 'src/y.ts'],
      // One triangle whose n→o pair carries two parallel import statements:
      // both witness the same `from>to` pair, so the first import string
      // ('./o-alias') survives and the duplicate drops.
      ['src/m.ts', 'src/n.ts'], ['src/n.ts', 'src/o.ts'], ['src/o.ts', 'src/m.ts'],
      ['src/n.ts', 'src/o.ts', './o-alias'],
    ])
    const answer = cyclesAnswer(inputFor(facet, readEpochs(db)), { op: 'cycles' })
    expect(answer.candidateCount).toBe(3)
    expect(answer.cycles?.map(component => component.id)).toEqual(['cycle:1', 'cycle:2', 'cycle:3'])
    // Size still leads; the two size-2 components tie-break on their sorted
    // member lists, putting p/q before x/y.
    expect(answer.cycles?.[0]?.memberIds).toEqual(['src/m.ts', 'src/n.ts', 'src/o.ts'])
    expect(answer.cycles?.[1]?.memberIds).toEqual(['src/p.ts', 'src/q.ts'])
    const triangle = answer.cycles?.[0]
    expect(triangle?.witnessEdges.map(edge => [edge.from, edge.to, edge.importString])).toEqual([
      ['src/m.ts', 'src/n.ts', './src/n.ts'],
      ['src/n.ts', 'src/o.ts', './o-alias'],
      ['src/o.ts', 'src/m.ts', './src/m.ts'],
    ])
  })
})

describe('provider wiring', () => {
  it('detects a real two-file import cycle through the parsed graph', async () => {
    const files = {
      'src/cyc-a.ts': "import { bHelper } from './cyc-b'\n\nexport function aHelper(): number {\n  return bHelper()\n}\n",
      'src/cyc-b.ts': "import { aHelper } from './cyc-a'\n\nexport function bHelper(): number {\n  return aHelper()\n}\n",
    }
    const root = await makeWorkspace('rlh-cycles-runtime-', { files })
    const runtime = new LocalCodeIndexRuntime({
      workspaceRoot: root,
      databasePath: ':memory:',
      journalMode: 'wal',
      excludePatterns: [],
      maxFileBytes: 512_000,
    })
    try {
      const answer = await runtime.exploreGraph({ op: 'cycles' })
      expect(answer.op).toBe('cycles')
      expect(answer.truncated).toBe(false)
      expect(answer.candidateCount).toBe(1)
      expect(answer.cycles?.[0]).toMatchObject({
        id: 'cycle:1',
        size: 2,
        severity: 'low',
      })
      expect(answer.cycles?.[0]?.memberIds).toEqual(['src/cyc-a.ts', 'src/cyc-b.ts'])
      expect(answer.cycles?.[0]?.witnessEdges.length).toBeGreaterThanOrEqual(2)
    } finally {
      await runtime.dispose()
    }
  })
})
