/**
 * The `exploreGraph` seam verb over a real workspace and a real store: the
 * `relations` walk (callers/callees/both, depth 2, caps, not-found), the
 * `impact` sweep (file/symbol seeds, test pairs, includeTests), and the
 * `tests` mapping — plus the provider wiring that lazily builds the index
 * before the first explore.
 *
 * The fixture's call graph is engine ← pump ← drain, one cross-file caller
 * per symbol. Every function ALSO carries a self-loop edge at its declaration
 * line (the parser's regex fallback lane reads the `name()` parameter list as
 * a call site); explore projects stored edges faithfully, so self-loops show
 * up in the walks and the tests pin them.
 *
 * Test edges need the incremental test-edge rebuild (a full build skips it by
 * contract), so the harness always follows the full build with a second pass
 * that rewrites the test file and removes a disposable file.
 */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRetrievalPort, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import { SymbolCatalog, catalogRowFromStored, createSymbolResolver } from '@relay-harness/rlh-code-index-graph'
import { DEFAULT_INCLUDE_PATTERNS } from '../src/scanner.ts'
import { buildExclusionStack, loadIndexedSnapshot, openStore, runRefreshPass } from '../src/indexer.ts'
import { edgeConfidenceOf, exploreGraphAnswer } from '../src/explore.ts'
import { LocalCodeIndexRuntime } from '../src/provider.ts'
import type { ExploreGraphInput } from '../src/explore.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

const ENGINE = 'export function spoolQuantaMarker(): number {\n  return 1\n}\n'
const PUMP = "import { spoolQuantaMarker } from './engine'\n\nexport function pumpCycle(): number {\n  return spoolQuantaMarker()\n}\n"
const DRAIN = "import { pumpCycle } from './pump'\n\nexport function drainAll(): number {\n  return pumpCycle()\n}\n"
const ENGINE_TEST = "test('engine', () => {\n  expect(1).toBe(1)\n})\n"
const NOTES = 'disposable notes\n'

const FIXTURE_FILES = {
  'src/engine.ts': ENGINE,
  'src/pump.ts': PUMP,
  'src/drain.ts': DRAIN,
  'tests/engine.test.ts': ENGINE_TEST,
  'notes.md': NOTES,
}

const ENGINE_TEST_PAIR: { testFilePath: string; codeFilePath: string; reason: string; confidence: number } = {
  testFilePath: 'tests/engine.test.ts',
  codeFilePath: 'src/engine.ts',
  reason: 'same-basename',
  confidence: 0.9,
}

/**
 * The clip fixture: the extra code paths CONTAIN the short-stem test files'
 * fragments (path-overlap pairs) and the engine test file pairs with all
 * three code paths, so one code-seeded question yields five pairs.
 */
function clipFixture(): Record<string, string> {
  return {
    ...FIXTURE_FILES,
    'src/engine_x.ts': 'export const engineX = 1\n',
    'src/engine_y.ts': 'export const engineY = 2\n',
    'tests/eng.test.ts': "test('eng', () => {\n  expect(1).toBe(1)\n})\n",
    'tests/engi.test.ts': "test('engi', () => {\n  expect(1).toBe(1)\n})\n",
  }
}

/**
 * Build a real indexed store for the fixture and answer explores against its
 * graph facet. The full build is followed by an incremental pass (rewritten
 * test files plus one removal) so the path-derived test edges are committed;
 * the store stays open for the test's lifetime (in-memory, swept workspace
 * files) and the passes run exactly as the provider runs them.
 */
async function buildInput(files: Readonly<Record<string, string>> = FIXTURE_FILES): Promise<ExploreGraphInput> {
  const root = await makeWorkspace('rlh-explore-', { files })
  const store = await openStore(':memory:', 'wal')
  const port = createRetrievalPort(store.db)
  const catalog = new SymbolCatalog()
  const resolver = createSymbolResolver({
    catalog,
    loadSymbolsForFiles: (missing) => {
      const wanted = missing.filter(file => !catalog.byFile.has(file))
      if (wanted.length === 0) return
      const rows = port.graph.symbolsByFilePaths(wanted)
      if (rows.length > 0) catalog.addSymbols(rows.map(catalogRowFromStored))
    },
  })
  const exclusionFilters = await buildExclusionStack(root, [])
  const baseInputs = {
    db: store.db,
    workspaceRoot: root,
    includePatterns: DEFAULT_INCLUDE_PATTERNS,
    exclusionFilters,
    maxFileBytes: 512_000,
    graph: port.graph,
    resolver,
    dirtyMaxFiles: 200,
  }
  await runRefreshPass({ ...baseInputs, previousGeneration: new Map() })
  const testFiles = Object.keys(files).filter(file => file.endsWith('.test.ts'))
  if (testFiles.length > 0) {
    for (const file of testFiles) {
      await writeFile(join(root, file), `${files[file] as string}// touched\n`)
    }
    if (files['notes.md'] !== undefined) await rm(join(root, 'notes.md'), { force: true })
    await runRefreshPass({ ...baseInputs, previousGeneration: loadIndexedSnapshot(store.db) })
  }
  return {
    request: { op: 'relations', symbol: 'spoolQuantaMarker' },
    facet: port.graph,
    limits: { maxResolve: 3, callersPerSym: 2, calleesPerSym: 2, maxTests: 2, maxRoutes: 1, graphBudgetPct: 20 },
    tier: 'tiny',
    epochs: readEpochs(store.db),
  }
}

describe('relations op', () => {
  it('walks callers of a resolved symbol and renders target and caller nodes', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'spoolQuantaMarker', direction: 'callers' } })
    expect(answer.op).toBe('relations')
    expect(answer.indexEpoch).toEqual(input.epochs)
    expect(answer.tier).toBe('tiny')
    expect(answer.truncated).toBe(false)
    expect(answer.explain).toEqual({ declared: ['CALLS'], readErrors: [], droppedReadErrorCount: 0 })
    expect(answer.candidateCount).toBe(2)
    expect(answer.tests).toBeUndefined()
    const nodeViews = answer.nodes.map(node =>
      ({ name: node.name, kind: node.kind, filePath: node.filePath, startLine: node.startLine, role: node.role }))
    expect(nodeViews).toEqual([
      { name: 'spoolQuantaMarker', kind: 'function', filePath: 'src/engine.ts', startLine: 1, role: 'target' },
      { name: 'pumpCycle', kind: 'function', filePath: 'src/pump.ts', startLine: 3, role: 'caller' },
    ])
    expect(answer.edges).toHaveLength(2)
    const [selfLoop, callerEdge] = answer.edges
    expect(selfLoop).toMatchObject({ edgeId: 'edge:1', kind: 'CALLS', source: answer.nodes[0]?.nodeId, target: answer.nodes[0]?.nodeId, line: 1, confidence: 0.9, reason: 'src/engine.ts:1' })
    expect(callerEdge).toMatchObject({ edgeId: 'edge:2', kind: 'CALLS', source: answer.nodes[1]?.nodeId, target: answer.nodes[0]?.nodeId, line: 4, confidence: 0.5, reason: 'src/pump.ts:4' })
  })

  it('walks callees on demand and merges both directions without duplicates', async () => {
    const input = await buildInput()
    const callees = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'drainAll', direction: 'callees' } })
    expect(callees.candidateCount).toBe(2)
    expect(callees.edges).toHaveLength(2)
    expect(callees.nodes.map(node => node.role)).toEqual(['target', 'callee'])

    const both = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'pumpCycle', direction: 'both' } })
    // pump's walks share the declaration self-loop; dedup leaves 3 distinct edges.
    expect(both.candidateCount).toBe(3)
    expect(both.edges).toHaveLength(3)
    expect(both.nodes.map(node => node.role).sort()).toEqual(['callee', 'caller', 'target'])
  })

  it('follows a second hop from the first-hop neighbors when depth is 2', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'drainAll', direction: 'callees', depth: 2 } })
    expect(answer.candidateCount).toBe(4)
    expect(answer.edges).toHaveLength(4)
    expect(answer.nodes).toHaveLength(3)
    expect(answer.truncated).toBe(false)
  })

  it('clips at a requested node cap and records the max_nodes reason', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'drainAll', direction: 'callees', depth: 2, max: 2 } })
    expect(answer.truncated).toBe(true)
    expect(answer.explain.truncatedReason).toBe('max_nodes')
    expect(answer.nodes).toHaveLength(2)
    expect(answer.edges).toHaveLength(3)
    expect(answer.candidateCount).toBe(4)
  })

  it('answers a symbol that resolves to nothing with an empty degraded-free answer', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'ghostSymbol' } })
    expect(answer.nodes).toEqual([])
    expect(answer.edges).toEqual([])
    expect(answer.candidateCount).toBe(0)
    expect(answer.truncated).toBe(false)
    expect(answer.explain.truncatedReason).toBeUndefined()
    expect(answer.explain.readErrors).toEqual(['symbol_not_found: ghostSymbol'])
  })

  it('pins a shared name to one file via filePath', async () => {
    const input = await buildInput({
      'a/dupe.ts': 'export function shared(): number {\n  return 1\n}\n',
      'b/dupe.ts': 'export function shared(): number {\n  return 2\n}\n',
    })
    const pinned = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'shared', filePath: 'b/dupe.ts', direction: 'callees' } })
    expect(pinned.nodes).toHaveLength(1)
    expect(pinned.nodes[0]?.filePath).toBe('b/dupe.ts')
    expect(pinned.nodes[0]?.startLine).toBe(1)
  })
})

describe('impact op', () => {
  it('sweeps reverse reachability of file seeds and attaches impacted tests', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'impact', files: ['src/engine.ts'] } })
    expect(answer.explain.declared).toEqual(['CALLS', 'TESTS'])
    expect(answer.nodes.map(node => node.role).sort()).toEqual(['caller', 'target'])
    expect(answer.candidateCount).toBe(2)
    expect(answer.edges).toHaveLength(2)
    expect(answer.truncated).toBe(false)
    expect(answer.tests).toEqual([ENGINE_TEST_PAIR])
  })

  it('clips the test-pair list at the tier cap and records result_limit', async () => {
    const input = await buildInput(clipFixture())
    const answer = exploreGraphAnswer({ ...input, request: { op: 'impact', files: ['src/engine.ts', 'src/engine_x.ts', 'src/engine_y.ts'] } })
    expect(answer.candidateCount).toBe(2)
    expect(answer.truncated).toBe(true)
    expect(answer.explain.truncatedReason).toBe('result_limit')
    expect(answer.tests).toEqual([
      { testFilePath: 'tests/eng.test.ts', codeFilePath: 'src/engine.ts', reason: 'path-overlap', confidence: 0.7 },
      { testFilePath: 'tests/eng.test.ts', codeFilePath: 'src/engine_x.ts', reason: 'path-overlap', confidence: 0.7 },
    ])
  })

  it('clips rendered seed nodes at a requested max and records max_nodes', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'impact', files: ['src/engine.ts'], max: 1 } })
    expect(answer.truncated).toBe(true)
    expect(answer.explain.truncatedReason).toBe('max_nodes')
    expect(answer.nodes).toHaveLength(1)
    expect(answer.edges).toHaveLength(1)
    expect(answer.candidateCount).toBe(2)
  })

  it('resolves a symbol seed to its file and records a not-found seed as degraded', async () => {
    const input = await buildInput()
    const seeded = exploreGraphAnswer({ ...input, request: { op: 'impact', symbol: 'pumpCycle' } })
    expect(seeded.candidateCount).toBe(2)
    expect(seeded.edges).toHaveLength(2)
    expect(seeded.nodes.map(node => node.role).sort()).toEqual(['caller', 'target'])
    expect(seeded.tests).toEqual([])
    expect(seeded.truncated).toBe(false)
    expect(seeded.explain.readErrors).toEqual([])

    const ghost = exploreGraphAnswer({ ...input, request: { op: 'impact', symbol: 'ghostSymbol' } })
    expect(ghost.nodes).toEqual([])
    expect(ghost.edges).toEqual([])
    expect(ghost.explain.readErrors).toEqual(['symbol_not_found: ghostSymbol'])
    expect(ghost.truncated).toBe(false)
  })

  it('omits tests when includeTests is false', async () => {
    const input = await buildInput()
    const withoutTests = exploreGraphAnswer({ ...input, request: { op: 'impact', files: ['src/engine.ts'], includeTests: false } })
    expect(withoutTests.tests).toBeUndefined()
    expect(withoutTests.truncated).toBe(false)
    expect(withoutTests.edges).toHaveLength(2)
  })

  it('guards the seam contract when no seed is given', async () => {
    const input = await buildInput()
    expect(() => exploreGraphAnswer({ ...input, request: { op: 'impact' } })).toThrow('impact explore requires a symbol or at least one file')
    expect(() => exploreGraphAnswer({ ...input, request: { op: 'tests' } as unknown as ExploreGraphInput['request'] })).toThrow('tests explore requires at least one file')
  })
})

describe('tests op', () => {
  it('maps code files to covering test pairs, clipped to the tier cap or the request', async () => {
    const input = await buildInput()
    const answer = exploreGraphAnswer({ ...input, request: { op: 'tests', files: ['src/engine.ts'] } })
    expect(answer.explain.declared).toEqual(['TESTS'])
    expect(answer.nodes).toEqual([])
    expect(answer.edges).toEqual([])
    expect(answer.candidateCount).toBe(1)
    expect(answer.truncated).toBe(false)
    expect(answer.explain.truncatedReason).toBeUndefined()
    expect(answer.tests).toEqual([ENGINE_TEST_PAIR])

    const three = await buildInput(clipFixture())
    const capped = exploreGraphAnswer({ ...three, request: { op: 'tests', files: ['src/engine.ts', 'src/engine_x.ts', 'src/engine_y.ts'] } })
    expect(capped.candidateCount).toBe(9)
    expect(capped.truncated).toBe(true)
    expect(capped.explain.truncatedReason).toBe('result_limit')
    expect(capped.tests).toEqual([
      { testFilePath: 'tests/eng.test.ts', codeFilePath: 'src/engine.ts', reason: 'path-overlap', confidence: 0.7 },
      { testFilePath: 'tests/eng.test.ts', codeFilePath: 'src/engine_x.ts', reason: 'path-overlap', confidence: 0.7 },
    ])

    const one = exploreGraphAnswer({ ...three, request: { op: 'tests', files: ['src/engine.ts', 'src/engine_x.ts', 'src/engine_y.ts'], max: 1 } })
    expect(one.tests).toHaveLength(1)
    expect(one.truncated).toBe(true)
    expect(one.explain.truncatedReason).toBe('result_limit')
  })
})

describe('edge confidence derivation', () => {
  it('maps the stored resolution kinds and falls back to zero', () => {
    expect(edgeConfidenceOf('exact')).toBe(1)
    expect(edgeConfidenceOf('qualified')).toBe(0.95)
    expect(edgeConfidenceOf('scope_resolved')).toBe(0.9)
    expect(edgeConfidenceOf('heuristic')).toBe(0.5)
    expect(edgeConfidenceOf('unresolved')).toBe(0)
    expect(edgeConfidenceOf(null)).toBe(0)
    expect(edgeConfidenceOf('mystery')).toBe(0)
  })
})

describe('synthetic store shapes', () => {
  it('projects edges with missing lines, call kinds, or endpoint uids faithfully', async () => {
    const store = await openStore(':memory:', 'wal')
    const port = createRetrievalPort(store.db)
    store.db.prepare(
      'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/a.ts', 'TypeScript', 'h', 1, 10, '2026-01-01')
    store.db.prepare(
      'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, symbol_uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s1', 'src/a.ts', 'callerFn', 'function', 1, 2, 'u1')
    store.db.prepare(
      'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, symbol_uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s2', 'src/a.ts', 'targetFn', 'function', 4, 5, 'u2')
    // Null line and null call kind: the projection omits both optional fields
    // and reads the confidence off the stored resolution kind.
    store.db.prepare(
      'INSERT INTO call_edges (edge_id, file_path, caller_symbol, callee_symbol, caller_symbol_uid, callee_symbol_uid, resolution_kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('e1', 'src/a.ts', 'callerFn', 'targetFn', 'u1', 'u2', 'exact')
    // Unresolved caller uids (NULL and empty string) drop before dedup and
    // rendering instead of producing unreachable nodes.
    store.db.prepare(
      'INSERT INTO call_edges (edge_id, file_path, callee_symbol, callee_symbol_uid, line) VALUES (?, ?, ?, ?, ?)',
    ).run('e2', 'src/a.ts', 'targetFn', 'u2', 9)
    store.db.prepare(
      'INSERT INTO call_edges (edge_id, file_path, caller_symbol, callee_symbol, caller_symbol_uid, callee_symbol_uid, line) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('e3', 'src/a.ts', 'ghost', 'targetFn', '', 'u2', 10)
    // A dangling endpoint: the edge survives the walk but its caller has no
    // symbols row, so it cannot render.
    store.db.prepare(
      'INSERT INTO call_edges (edge_id, file_path, caller_symbol, callee_symbol, caller_symbol_uid, callee_symbol_uid, line) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('e4', 'src/a.ts', 'missing', 'targetFn', 'u9', 'u2', 11)
    const input: ExploreGraphInput = {
      request: { op: 'relations', symbol: 'targetFn', direction: 'callers' },
      facet: port.graph,
      // The per-seed window of 4 keeps the dangling row inside the read.
      limits: { maxResolve: 3, callersPerSym: 4, calleesPerSym: 3, maxTests: 2, maxRoutes: 1, graphBudgetPct: 20 },
      tier: 'tiny',
      epochs: readEpochs(store.db),
    }
    const answer = exploreGraphAnswer(input)
    expect(answer.candidateCount).toBe(2)
    expect(answer.edges).toEqual([
      { edgeId: 'edge:1', kind: 'CALLS', source: 'u1', target: 'u2', confidence: 1, reason: 'src/a.ts:0' },
    ])
    expect(answer.nodes.map(node => node.role)).toEqual(['target', 'caller'])
    expect(answer.truncated).toBe(false)

    // Omitting the direction walks both sides; a node cap refused on the
    // CALLER endpoint stops rendering with the same max_nodes reason.
    const both = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'targetFn' } })
    expect(both.candidateCount).toBe(2)
    const capped = exploreGraphAnswer({ ...input, request: { op: 'relations', symbol: 'targetFn', direction: 'callers', max: 1 } })
    expect(capped.truncated).toBe(true)
    expect(capped.explain.truncatedReason).toBe('max_nodes')
    expect(capped.edges).toEqual([])
    expect(capped.nodes).toHaveLength(1)
  })
})

describe('provider wiring', () => {
  it('lazily builds the index on the first explore and answers under the committed epochs', async () => {
    const root = await makeWorkspace('rlh-explore-runtime-', { files: FIXTURE_FILES })
    const runtime = new LocalCodeIndexRuntime({
      workspaceRoot: root,
      databasePath: ':memory:',
      journalMode: 'wal',
      excludePatterns: [],
      maxFileBytes: 512_000,
    })
    try {
      const answer = await runtime.exploreGraph({ op: 'relations', symbol: 'spoolQuantaMarker', direction: 'callers' })
      expect(answer.op).toBe('relations')
      expect(answer.tier).toBe('tiny')
      expect(answer.candidateCount).toBe(2)
      expect(answer.indexEpoch.indexEpoch).toBeGreaterThanOrEqual(1)
      expect(runtime.indexedFileCount()).toBeGreaterThanOrEqual(Object.keys(FIXTURE_FILES).length)
    } finally {
      await runtime.dispose()
    }
  })
})
