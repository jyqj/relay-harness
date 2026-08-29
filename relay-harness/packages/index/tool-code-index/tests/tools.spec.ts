/**
 * Consumer-surface tests for the three code-index tools, exercised through
 * `ctx.tools.execute()` over a recording stub provider so nothing bypasses the
 * registry. Covers schemas, prompt guidance, argument validation, seam
 * availability and error normalization, tier byte-cap envelopes, renderers,
 * presenters, the top-K clamp config, and the refresh busy guard.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { CallId, HarnessError } from '@relay-harness/rlh-llm'
import { CodeIndex, CODE_INDEX_NOT_INDEXED } from '@relay-harness/rlh-code-index'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  HydrateChunksRequest,
  HydrateChunksResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'
import SystemPrompt, { renderPrompt } from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import type { ToolExecutionResult, ToolResult } from '@relay-harness/rlh-tools'
import {
  INDEX_TOOL_FAILED,
  INDEX_TOOL_REFRESH_IN_PROGRESS,
  INDEX_TOOL_UNAVAILABLE,
  formatCycleComponent,
  formatDeadCode,
  formatGraphEdge,
  formatGraphNode,
  formatSearchHit,
  formatTestPair,
  isTruncationEnvelope,
  parseExploreArgs,
  parseSearchArgs,
  presentExploreCall,
  presentExploreResult,
  presentRefreshCall,
  presentRefreshResult,
  presentSearchCall,
  presentSearchResult,
  presentStatusCall,
  presentStatusResult,
  renderExploreOutput,
  renderRefreshOutput,
  renderSearchOutput,
  renderStatusOutput,
  toExploreRequest,
  toPlainGraphResult,
  toPlainSearchResult,
} from '../src/index.ts'
import * as ToolCodeIndex from '../src/index.ts'

const TEST_SIGNAL = new AbortController().signal

/** Deterministic two-hit fixture on the tiny tier (18_000-byte exit budget). */
function fixtureSearch(): SearchResult {
  return toPlainSearchResult({
    query: 'parse ledger',
    tier: 'tiny',
    hits: [
      {
        chunkId: 'chunk:src/a.ts:3',
        filePath: 'src/a.ts',
        language: 'typescript',
        contentHash: 'hash-a',
        startLine: 10,
        endLine: 24,
        breadcrumb: 'module parseLedger',
        symbolName: 'parseLedger',
        score: 7.25,
        rank: 1,
        reasons: ['exact identifier', 'recent file'],
        scoreTrace: [{ label: 'rrf:lexical', value: 7.25 }],
        parserTier: 'tree-sitter',
        parserConfidence: 0.9,
      },
      {
        chunkId: 'chunk:src/b.ts:0',
        filePath: 'src/b.ts',
        language: 'typescript',
        contentHash: 'hash-b',
        startLine: 40,
        endLine: 48,
        score: 2.5,
        rank: 2,
        reasons: ['lexical'],
        scoreTrace: [{ label: 'rrf:lexical', value: 2.5 }],
        parserTier: 'heuristic',
        parserConfidence: 0.4,
      },
    ],
    candidateCount: 9,
    epochs: { indexEpoch: 4, evidenceEpoch: 0 },
    truncated: false,
    degraded: false,
    readErrors: [],
  })
}

function emptyStatus(): IndexStatusReport {
  return { indexedFileCount: 12, tier: 'tiny', epochs: { indexEpoch: 4, evidenceEpoch: 0 }, degraded: false }
}

/** Deterministic relations answer on the tiny tier. */
function fixtureGraph(): GraphExploreResult {
  return {
    op: 'relations',
    indexEpoch: { indexEpoch: 4, evidenceEpoch: 0 },
    nodes: [
      { nodeId: 'uid:spool', name: 'spoolQuantaMarker', kind: 'function', filePath: 'src/engine.ts', startLine: 1, role: 'target' },
      { nodeId: 'uid:pump', name: 'pumpCycle', kind: 'function', filePath: 'src/pump.ts', startLine: 3, role: 'caller' },
    ],
    edges: [
      {
        edgeId: 'edge:1',
        kind: 'CALLS',
        source: 'uid:pump',
        target: 'uid:spool',
        line: 4,
        callKind: 'direct',
        confidence: 0.5,
        reason: 'src/pump.ts:4',
      },
    ],
    explain: { declared: ['CALLS'], readErrors: [], droppedReadErrorCount: 0 },
    truncated: false,
    candidateCount: 1,
    tier: 'tiny',
  }
}

/** Tests-op answer carrying one test pair plus a result-limit clip. */
function fixtureTests(): GraphExploreResult {
  return {
    op: 'tests',
    indexEpoch: { indexEpoch: 4, evidenceEpoch: 0 },
    nodes: [],
    edges: [],
    tests: [
      { testFilePath: 'tests/spool.test.ts', codeFilePath: 'src/spool.ts', reason: 'same-basename', confidence: 0.9 },
      { testFilePath: 'tests/spool2.test.ts', codeFilePath: 'src/spool.ts', reason: 'same-basename', confidence: 0.9 },
      { testFilePath: 'tests/spool3.test.ts', codeFilePath: 'src/spool.ts', reason: 'same-basename', confidence: 0.9 },
    ],
    explain: { declared: ['TESTS'], readErrors: [], droppedReadErrorCount: 0, truncatedReason: 'result_limit' },
    truncated: true,
    candidateCount: 3,
    tier: 'tiny',
  }
}

/** Cycles-op answer with one witnessed component and a cap clip. */
function fixtureCycles(): GraphExploreResult {
  return {
    op: 'cycles',
    indexEpoch: { indexEpoch: 4, evidenceEpoch: 0 },
    nodes: [],
    edges: [],
    cycles: [
      {
        id: 'cycle:1',
        size: 2,
        severity: 'low',
        memberIds: ['src/engine.ts', 'src/pump.ts'],
        witnessEdges: [
          { from: 'src/engine.ts', to: 'src/pump.ts', importString: './pump' },
          { from: 'src/pump.ts', to: 'src/engine.ts', importString: './engine' },
        ],
      },
      {
        id: 'cycle:2',
        size: 2,
        severity: 'low',
        memberIds: ['src/a.ts', 'src/b.ts'],
        witnessEdges: [],
      },
    ],
    explain: { declared: ['IMPORTS'], readErrors: [], droppedReadErrorCount: 0, truncatedReason: 'result_limit' },
    truncated: true,
    candidateCount: 3,
    tier: 'tiny',
  }
}

/** Dead-code-op answer with two candidates, one clipped by the cap. */
function fixtureDeadCode(): GraphExploreResult {
  return {
    op: 'dead_code',
    indexEpoch: { indexEpoch: 4, evidenceEpoch: 0 },
    nodes: [],
    edges: [],
    deadCode: [
      { symbolName: 'drainAll', symbolId: 'uid:drainAll', filePath: 'src/drain.ts', kind: 'function', reason: 'no-callers' },
      { symbolName: 'legacyHelper', symbolId: 'uid:legacyHelper', filePath: 'src/legacy.ts', kind: 'function', reason: 'no-callers' },
    ],
    explain: { declared: ['CALLS', 'REFERENCES'], readErrors: [], droppedReadErrorCount: 0 },
    truncated: false,
    candidateCount: 2,
    tier: 'tiny',
  }
}

/** Stub provider recording every seam verb; each verb's behavior is scriptable per test. */
class RecordingIndex extends CodeIndex {
  requests: SearchRequest[] = []
  graphRequests: GraphExploreRequest[] = []
  refreshes: RefreshOptions[] = []
  private indexEpoch = 4
  searchImpl: (request: SearchRequest) => Promise<SearchResult> = async request => ({
    ...fixtureSearch(),
    query: request.query,
  })
  exploreImpl: (request: GraphExploreRequest) => Promise<GraphExploreResult> = (async (request) => {
    if (request.op === 'tests') return fixtureTests()
    if (request.op === 'cycles') return fixtureCycles()
    if (request.op === 'dead_code') return fixtureDeadCode()
    return { ...fixtureGraph(), op: request.op }
  })
  statusImpl: () => Promise<IndexStatusReport> = async () =>
    ({ ...emptyStatus(), epochs: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 } })
  refreshImpl: (options?: RefreshOptions) => Promise<RefreshSummary> = async (_options) => {
    this.indexEpoch += 1
    return {
      reason: 'manual',
      changedFiles: 3,
      removedFiles: 1,
      chunksWritten: 17,
      durationMs: 8,
      epochsAfter: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 },
    }
  }

  override async status(): Promise<IndexStatusReport> {
    return this.statusImpl()
  }

  override async refresh(options?: RefreshOptions): Promise<RefreshSummary> {
    this.refreshes.push(options ?? {})
    return this.refreshImpl(options)
  }

  override async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request)
    return this.searchImpl(request)
  }

  override async hydrateChunks(request: HydrateChunksRequest): Promise<HydrateChunksResult> {
    return {
      chunks: [],
      rejected: request.chunkIds.map(chunkId => ({ chunkId, state: 'unavailable', reason: 'not-indexed' })),
      epochs: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 },
    }
  }

  override async exploreGraph(request: GraphExploreRequest): Promise<GraphExploreResult> {
    this.graphRequests.push(request)
    return this.exploreImpl(request)
  }
}

interface SetupOptions {
  /** Load a provider under `ctx.codeIndex` before the tools mount. */
  withProvider?: boolean
  config?: ToolCodeIndex.Config
}

async function setup(options: SetupOptions = {}): Promise<{ ctx: Context; index: RecordingIndex; fiber: unknown }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.withProvider !== false) await ctx.plugin(RecordingIndex)
  const fiber = await ctx.plugin(ToolCodeIndex, options.config)
  if (fiber === undefined) throw new Error('tool plugin did not activate')
  return { ctx, index: ctx.codeIndex as RecordingIndex, fiber }
}

let callCounter = 0

/** One settled call as observed by BOTH surfaces: model-facing content and the frozen outcome event. */
interface CallOutcome {
  content: string
  isError: boolean
  settled: Readonly<ToolExecutionResult>
}

async function call(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const settled: ToolExecutionResult[] = []
  ctx.on('tools/result', (_exec, result) => {
    settled.push(result)
  })
  const result: ToolResult = await ctx.tools.execute({
    signal: TEST_SIGNAL,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session: { header: { cwd: process.cwd() } } } as never,
  })
  const content = result.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
  const frozen = settled.at(-1)
  if (frozen === undefined) throw new Error('tools/result never fired for this call')
  return {
    content,
    isError: result.isError,
    settled: frozen,
  }
}

const outcomeValue = (outcome: CallOutcome): unknown => outcome.settled.value

/** Stable structured `{ name, code }` metadata exposed for a HarnessError-carrying failure. */
const outcomeErrorCode = (outcome: CallOutcome): string | undefined => outcome.settled.error?.info?.code

describe('registration', () => {
  it('registers all four tools plus one fixed prompt section in the dense tool band', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual(['code_index_status', 'explore_code_graph', 'refresh_code_index', 'search_code_index'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Prefer search_code_index over grep/glob')
    expect(prompt).toContain('use explore_code_graph for cross-file structure questions')
    expect(prompt).toContain('surfaces circular import cycles and never-called symbols')
    expect(prompt).toContain('refresh_code_index (force only')
    expect(ToolCodeIndex.CODE_INDEX_PROMPT_SECTION_NAME).toBe('tool:code-index')
    expect(ToolCodeIndex.CODE_INDEX_PROMPT_SECTION_ORDER).toBe(107)
  })

  it('unregisters every tool and prompt guidance on fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas()).toHaveLength(4)
    await (fiber as { dispose(): Promise<void> }).dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).not.toContain('Prefer search_code_index over grep/glob')
  })

  it('keeps the top_k lever by default and drops it when clamping to tier', async () => {
    const keptProps = ((await setup({ config: { clampTopKToTier: false } })).ctx.tools.schemas()
      .find(schema => schema.name === 'search_code_index')?.parameters as { properties?: Record<string, object> }).properties ?? {}
    expect(Object.hasOwn(keptProps, 'top_k')).toBe(true)
    expect(Object.hasOwn(keptProps.top_k!, 'description')).toBe(true)

    const clampedSchema = (await setup({ config: { clampTopKToTier: true } })).ctx.tools.schemas()
      .find(schema => schema.name === 'search_code_index')
    const clampedProps = (clampedSchema?.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {}
    expect(Object.hasOwn(clampedProps, 'top_k')).toBe(false)
    // Every remaining schema property remains described for the model.
    for (const property of Object.values(clampedProps)) {
      expect(property).toHaveProperty('description')
    }
  })
})

describe('search_code_index execution', () => {
  it('returns the complete canonical result and compact ranked lines', async () => {
    const { ctx, index } = await setup()
    const outcome = await call(ctx, 'search_code_index', { query: 'parse ledger', recent_paths: ['src/a.ts'], include_grep: false })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue(outcome)).toEqual(fixtureSearch())
    // Advisory hint rides onto the request alongside camelCase mapping.
    expect(index.requests[0]!).toMatchObject({ query: 'parse ledger', recentPaths: ['src/a.ts'], includeGrep: false })
    const lines = outcome.content.split('\n')
    expect(lines[0]).toBe('Query "parse ledger" (tiny tier)')
    expect(lines[1]).toBe('src/a.ts:10-24 7.25 exact identifier,recent file')
    expect(lines[2]).toBe('src/b.ts:40-48 2.5 lexical')
    expect(outcome.content).not.toContain('(showing')
  })

  it('appends candidate-count and degradation footers when the engine truncates or degrades', async () => {
    const { ctx, index } = await setup()
    index.searchImpl = async request => ({
      ...fixtureSearch(),
      query: request.query,
      hits: fixtureSearch().hits.slice(0, 1),
      truncated: true,
      degraded: true,
      readErrors: ['lane grep failed: db busy'],
    })
    const outcome = await call(ctx, 'search_code_index', { query: 'x' })
    expect(outcome.content).toContain('(showing 1 of 9 candidates)')
    expect(outcome.content).toContain('[degraded] lane grep failed: db busy — treat these results as partial; do not cache.')
  })

  it('renders the no-hit line for an empty answer', async () => {
    const { ctx, index } = await setup()
    index.searchImpl = async request => ({ ...fixtureSearch(), query: request.query, hits: [], candidateCount: 0 })
    const outcome = await call(ctx, 'search_code_index', { query: 'nothing' })
    expect(outcome.content).toContain('No indexed chunks matched this query.')
  })

  it('replaces an oversized serialized answer with the tier byte-cap envelope', async () => {
    const { ctx, index } = await setup()
    const fat = fixtureSearch()
    index.searchImpl = async request => ({
      ...fat,
      query: request.query,
      hits: [{
        ...fat.hits[0]!,
        reasons: ['filler '.repeat(4000)],
      }],
    })
    const outcome = await call(ctx, 'search_code_index', { query: 'fat' })
    expect(outcome.isError).toBe(false)
    const envelope = outcomeValue(outcome) as { _truncated?: boolean; _max_chars?: number }
    expect(envelope._truncated).toBe(true)
    expect(envelope._max_chars).toBe(18_000)
    expect(outcome.content).toContain('was too large for one result (')
    expect(outcome.content).toContain('Narrow path_prefix or top_k and retry.')
    expect(outcome.content).not.toContain('filler')
  })

  it('fails structured when no provider is loaded (deployment gap, not loop crash)', async () => {
    const { ctx } = await setup({ withProvider: false })
    const outcome = await call(ctx, 'search_code_index', { query: 'anything' })
    expect(outcome.isError).toBe(true)
    expect(outcomeErrorCode(outcome)).toBe(INDEX_TOOL_UNAVAILABLE)
    expect(outcome.content).toContain('no ctx.codeIndex service is loaded')
  })

  it('propagates stable provider codes and wraps opaque provider failures', async () => {
    const { ctx, index } = await setup()
    index.searchImpl = () => {
      throw new HarnessError('workspace has never been indexed', CODE_INDEX_NOT_INDEXED)
    }
    const propagated = await call(ctx, 'search_code_index', { query: 'x' })
    expect(outcomeErrorCode(propagated)).toBe(CODE_INDEX_NOT_INDEXED)

    index.searchImpl = () => Promise.reject(new TypeError('rows of doom'))
    const wrapped = await call(ctx, 'search_code_index', { query: 'x' })
    expect(outcomeErrorCode(wrapped)).toBe(INDEX_TOOL_FAILED)
    expect(wrapped.content).toContain('rows of doom')
  })

  it('respects the clamp config by dropping explicit top_k from the request', async () => {
    const { ctx, index } = await setup({ config: { clampTopKToTier: true } })
    await call(ctx, 'search_code_index', { query: 'x', top_k: 50 })
    expect(index.requests[0]!.topK).toBeUndefined()

    const loose = await setup({ config: { clampTopKToTier: false } })
    await call(loose.ctx, 'search_code_index', { query: 'x', top_k: 3 })
    expect(loose.index.requests[0]!.topK).toBe(3)
  })

  it('rejects argument mistakes as ordinary tool argument errors', async () => {
    const { ctx } = await setup()
    const blank = await call(ctx, 'search_code_index', { query: '   ' })
    expect(blank.isError).toBe(true)
    expect(blank.content).toContain('query must be a non-empty string')

    const badTopK = await call(ctx, 'search_code_index', { query: 'x', top_k: 0 })
    expect(badTopK.isError).toBe(true)
    expect(badTopK.content).toContain('top_k must be a positive integer')
    expect(parseSearchArgs({ query: 'ok', top_k: 2 }).query).toBe('ok')
  })

  it('maps arguments through path_prefix and skips includeGrep unless disabled', async () => {
    const { ctx, index } = await setup()
    await call(ctx, 'search_code_index', { query: 'q', path_prefix: 'packages/', paths: ['packages/index/code-index/src/types.ts'] })
    expect(index.requests[0]!).toMatchObject({ pathPrefix: 'packages/', paths: ['packages/index/code-index/src/types.ts'] })
    expect(index.requests[0]!).not.toHaveProperty('includeGrep')
    expect(index.requests[0]!.topK).toBeUndefined()
  })
})

describe('explore_code_graph execution', () => {
  it('returns the complete canonical answer and compact node/edge lines', async () => {
    const { ctx, index } = await setup()
    const outcome = await call(ctx, 'explore_code_graph', { op: 'relations', symbol: 'spoolQuantaMarker', direction: 'callers', depth: 2, file_path: 'src/engine.ts', max: 9 })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue(outcome)).toEqual(JSON.parse(JSON.stringify(fixtureGraph())) as unknown)
    expect(index.graphRequests[0]).toEqual({
      op: 'relations',
      symbol: 'spoolQuantaMarker',
      filePath: 'src/engine.ts',
      direction: 'callers',
      depth: 2,
      max: 9,
    })
    expect(outcome.content.split('\n')).toEqual([
      'relations explore (tiny tier)',
      'target function spoolQuantaMarker @ src/engine.ts:1',
      'caller function pumpCycle @ src/pump.ts:3',
      'caller: pumpCycle → spoolQuantaMarker (src/pump.ts:4)',
      'explain: declared=[CALLS] candidates=1',
    ])
  })

  it('renders the truncated footer and test pairs for a clipped tests answer', async () => {
    const { ctx } = await setup()
    const outcome = await call(ctx, 'explore_code_graph', { op: 'tests', files: ['src/spool.ts'] })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue(outcome)).toEqual(JSON.parse(JSON.stringify(fixtureTests())) as unknown)
    expect(outcome.content).toContain('test: tests/spool.test.ts → src/spool.ts (same-basename)')
    expect(outcome.content).toContain('(truncated: result_limit; 3 candidates considered)')
  })

  it('maps impact arguments and drops include_tests only when explicitly false', async () => {
    const { ctx, index } = await setup()
    await call(ctx, 'explore_code_graph', { op: 'impact', files: ['src/engine.ts'], include_tests: false, max: 4 })
    expect(index.graphRequests[0]).toEqual({ op: 'impact', files: ['src/engine.ts'], includeTests: false, max: 4 })

    await call(ctx, 'explore_code_graph', { op: 'impact', symbol: 'spoolQuantaMarker' })
    expect(index.graphRequests[1]).toEqual({ op: 'impact', symbol: 'spoolQuantaMarker' })
  })

  it('returns cycle components with witness edges and the truncated component line', async () => {
    const { ctx, index } = await setup()
    const outcome = await call(ctx, 'explore_code_graph', { op: 'cycles', max: 2 })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue(outcome)).toEqual(JSON.parse(JSON.stringify(fixtureCycles())) as unknown)
    expect(index.graphRequests[0]).toEqual({ op: 'cycles', max: 2 })
    expect(outcome.content.split('\n')).toEqual([
      'cycles explore (tiny tier)',
      'size 2: src/engine.ts → src/pump.ts',
      'size 2: src/a.ts → src/b.ts',
      'explain: declared=[IMPORTS] candidates=3',
      '(truncated: result_limit; 3 candidates considered)',
    ])
  })

  it('returns dead-code candidates with reasons and the empty line for a clean graph', async () => {
    const { ctx, index } = await setup()
    const outcome = await call(ctx, 'explore_code_graph', { op: 'dead_code' })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue(outcome)).toEqual(JSON.parse(JSON.stringify(fixtureDeadCode())) as unknown)
    expect(index.graphRequests[0]).toEqual({ op: 'dead_code' })
    expect(outcome.content.split('\n')).toEqual([
      'dead_code explore (tiny tier)',
      'dead: function drainAll @ src/drain.ts (no-callers)',
      'dead: function legacyHelper @ src/legacy.ts (no-callers)',
      'explain: declared=[CALLS,REFERENCES] candidates=2',
    ])

    index.exploreImpl = async request => ({ ...fixtureDeadCode(), op: request.op, deadCode: [], candidateCount: 0 })
    const clean = await call(ctx, 'explore_code_graph', { op: 'dead_code' })
    expect(clean.content).toContain('No graph entries matched this question.')
  })

  it('surfaces provider degradation tokens and omit-when-clean explain lines', async () => {
    const { ctx, index } = await setup()
    index.exploreImpl = async request => ({
      ...fixtureGraph(),
      op: request.op,
      explain: { declared: ['CALLS'], readErrors: ['symbol_not_found: ghost'], droppedReadErrorCount: 0 },
    })
    const outcome = await call(ctx, 'explore_code_graph', { op: 'relations', symbol: 'ghost' })
    expect(outcome.content).toContain('[degraded] symbol_not_found: ghost')
  })

  it('replaces an oversized serialized answer with the tier byte-cap envelope', async () => {
    const { ctx, index } = await setup()
    const fat = fixtureGraph()
    index.exploreImpl = async request => ({
      ...fat,
      op: request.op,
      nodes: [{ ...fat.nodes[0]!, name: 'x'.repeat(20_000) }],
    })
    const outcome = await call(ctx, 'explore_code_graph', { op: 'relations', symbol: 'spoolQuantaMarker' })
    expect(outcome.isError).toBe(false)
    const envelope = outcomeValue(outcome) as { _truncated?: boolean; _max_chars?: number }
    expect(envelope._truncated).toBe(true)
    expect(envelope._max_chars).toBe(18_000)
    expect(outcome.content).toContain('graph response was too large for one result (')
    expect(outcome.content).toContain('Narrow max or the queried symbol/files and retry.')
    expect(outcome.content).not.toContain('xxxx')
  })

  it('fails structured when no provider is loaded or the provider throws opaquely', async () => {
    const unavailable = await call((await setup({ withProvider: false })).ctx, 'explore_code_graph', { op: 'tests', files: ['a.ts'] })
    expect(outcomeErrorCode(unavailable)).toBe(INDEX_TOOL_UNAVAILABLE)

    const { ctx, index } = await setup()
    index.exploreImpl = () => Promise.reject(new TypeError('graph table locked'))
    const wrapped = await call(ctx, 'explore_code_graph', { op: 'tests', files: ['a.ts'] })
    expect(outcomeErrorCode(wrapped)).toBe(INDEX_TOOL_FAILED)
    expect(wrapped.content).toContain('graph table locked')
  })

  it('rejects cross-op illegal combinations as ordinary argument errors', async () => {
    const { ctx } = await setup()
    const mistakes: ReadonlyArray<{ args: Record<string, unknown>; message: string }> = [
      { args: { op: 'relations' }, message: 'symbol must be a non-empty string' },
      { args: { op: 'relations', symbol: 'x', files: ['a.ts'] }, message: 'files only applies to op=relations' },
      { args: { op: 'relations', symbol: 'x', include_tests: true }, message: 'include_tests only applies to op=relations' },
      { args: { op: 'relations', symbol: 'x', file_path: '   ' }, message: 'file_path must be a non-empty string' },
      { args: { op: 'relations', symbol: 'x', depth: 3 }, message: 'depth must be 1 or 2' },
      { args: { op: 'relations', symbol: 'x', max: 0 }, message: 'max must be a positive integer' },
      { args: { op: 'impact' }, message: 'op=impact requires symbol or files' },
      { args: { op: 'impact', files: [] }, message: 'op=impact requires symbol or files' },
      { args: { op: 'impact', symbol: 'x', files: ['   '] }, message: 'files must be a non-empty list of non-empty strings' },
      { args: { op: 'impact', files: ['a.ts'], direction: 'both' }, message: 'direction only applies to op=relations' },
      { args: { op: 'tests' }, message: 'op=tests requires files: a non-empty list of non-empty strings' },
      { args: { op: 'tests', files: [''] }, message: 'op=tests requires files: a non-empty list of non-empty strings' },
      { args: { op: 'tests', files: ['a.ts'], include_tests: false }, message: 'include_tests only applies to op=relations' },
      { args: { op: 'tests', files: ['a.ts'], symbol: 'x' }, message: 'symbol only applies to op=relations or op=impact' },
      { args: { op: 'cycles', symbol: 'x' }, message: 'symbol only applies to op=relations, impact, or tests' },
      { args: { op: 'cycles', files: ['a.ts'] }, message: 'files only applies to op=relations, impact, or tests' },
      { args: { op: 'cycles', depth: 2 }, message: 'depth only applies to op=relations, impact, or tests' },
      { args: { op: 'cycles', max: 0 }, message: 'max must be a positive integer' },
      { args: { op: 'dead_code', include_tests: true }, message: 'include_tests only applies to op=relations, impact, or tests' },
      { args: { op: 'dead_code', direction: 'both' }, message: 'direction only applies to op=relations, impact, or tests' },
      { args: { op: 'dead_code', file_path: 'a.ts' }, message: 'file_path only applies to op=relations, impact, or tests' },
    ]
    for (const { args, message } of mistakes) {
      const outcome = await call(ctx, 'explore_code_graph', args)
      expect(outcome.isError, JSON.stringify(args)).toBe(true)
      expect(outcome.content).toContain(message)
    }
    expect(parseExploreArgs({ op: 'tests', files: ['a.ts'] }).op).toBe('tests')
  })

  it('caps the requested max at a hard ceiling as an ordinary argument error', () => {
    expect(parseExploreArgs({ op: 'cycles', max: 10_000 })).toMatchObject({ max: 10_000 })
    expect(() => parseExploreArgs({ op: 'cycles', max: 10_001 })).toThrow('max must not exceed 10000')
    expect(() => parseExploreArgs({ op: 'dead_code', max: Number.MAX_SAFE_INTEGER })).toThrow('max must not exceed 10000')
  })

  it('keeps rendering helpers and presenters deterministic', () => {
    const fixture = fixtureGraph()
    const edge = fixture.edges[0]!
    const pair = fixtureTests().tests![0]!
    expect(formatGraphNode(fixture.nodes[0]!)).toBe('target function spoolQuantaMarker @ src/engine.ts:1')
    expect(formatGraphNode({ nodeId: 'n', name: 'spoolQuantaMarker', kind: 'function', filePath: 'src/engine.ts', startLine: 1 }))
      .toBe('function spoolQuantaMarker @ src/engine.ts:1')
    expect(formatGraphEdge(edge, new Map([['uid:pump', 'pumpCycle'], ['uid:spool', 'spoolQuantaMarker']])))
      .toBe('caller: pumpCycle → spoolQuantaMarker (src/pump.ts:4)')
    expect(formatGraphEdge({ edgeId: 'e', kind: 'CALLS', source: 'a', target: 'b', confidence: 0 }, new Map()))
      .toBe('caller: a → b (line 0)')
    expect(formatTestPair(pair)).toBe('test: tests/spool.test.ts → src/spool.ts (same-basename)')
    expect(presentExploreCall({ op: 'relations', symbol: 'spool' })).toEqual({
      card: 'generic',
      title: 'CodeIndex graph: relations: spool',
      kind: 'search',
      rawInput: 'spool',
    })
    expect(presentExploreCall({ op: 'tests', files: ['a.ts'] }).title).toBe('CodeIndex graph: tests')
    expect(presentExploreResult({ op: 'tests', files: ['a.ts'] }, { isError: true } as ToolResult)).toBeUndefined()
    expect(presentExploreResult({ op: 'relations', symbol: 'spool' }, { isError: false } as ToolResult))
      .toEqual({ card: 'generic', title: 'explore_code_graph · relations spool' })
    expect(toExploreRequest({ op: 'tests', files: ['b.ts'], max: 2 })).toEqual({ op: 'tests', files: ['b.ts'], max: 2 })
    expect(toExploreRequest({ op: 'relations', symbol: 'x', depth: 1 })).toEqual({ op: 'relations', symbol: 'x', depth: 1 })
    expect(toExploreRequest({ op: 'cycles' })).toEqual({ op: 'cycles' })
    expect(toExploreRequest({ op: 'dead_code', max: 7 })).toEqual({ op: 'dead_code', max: 7 })
    expect(formatCycleComponent(toPlainGraphResult(fixtureCycles()).cycles![0]!)).toBe('size 2: src/engine.ts → src/pump.ts')
    expect(formatDeadCode(toPlainGraphResult(fixtureDeadCode()).deadCode![0]!)).toBe('dead: function drainAll @ src/drain.ts (no-callers)')
    expect(() => parseExploreArgs({ op: 'relations', symbol: 'x', direction: 'sideways' as never })).toThrow('direction must be callers, callees, or both')
    const unclipped = toPlainGraphResult(fixtureTests())
    expect(renderExploreOutput({ ...unclipped, truncated: false, explain: { declared: ['TESTS'], readErrors: [], droppedReadErrorCount: 0 } }))
      .not.toContain('(truncated:')
    const reasonless = toPlainGraphResult(fixtureTests())
    expect(renderExploreOutput({ ...reasonless, explain: { declared: ['TESTS'], readErrors: [], droppedReadErrorCount: 0 } }))
      .toContain('(truncated: unknown; 3 candidates considered)')
    expect(presentExploreResult({ op: 'tests', files: ['a.ts'] }, { isError: false } as ToolResult))
      .toEqual({ card: 'generic', title: 'explore_code_graph · tests' })
  })
})

describe('code_index_status execution', () => {
  it('renders a passthrough report without a refresh', async () => {
    const { ctx } = await setup()
    const outcome = await call(ctx, 'code_index_status')
    expect(outcome.isError).toBe(false)
    expect(outcomeValue(outcome)).toMatchObject({ indexedFileCount: 12, tier: 'tiny' })
    expect(outcome.content.split('\n')).toEqual([
      'indexedFileCount: 12',
      'tier: tiny',
      'indexEpoch: 4',
      'evidenceEpoch: 0',
      'degraded: false',
      'lastRefresh: none',
    ])
  })

  it('renders the last refresh summary when present', () => {
    const text = renderStatusOutput({
      indexedFileCount: 5000,
      tier: 'medium',
      epochs: { indexEpoch: 9, evidenceEpoch: 0 },
      degraded: true,
      lastRefresh: {
        reason: 'stale',
        changedFiles: 6,
        removedFiles: 2,
        chunksWritten: 41,
        durationMs: 120,
        epochsAfter: { indexEpoch: 9, evidenceEpoch: 0 },
      },
    })
    expect(text).toContain('lastRefresh: reason=stale changedFiles=6 removedFiles=2 chunksWritten=41 durationMs=120 epochsAfter(index=9, evidence=0)')
  })

  it('reports missing providers and provider failures with structured codes', async () => {
    const unavailable = await call((await setup({ withProvider: false })).ctx, 'code_index_status')
    expect(outcomeErrorCode(unavailable)).toBe(INDEX_TOOL_UNAVAILABLE)

    const { ctx, index } = await setup()
    index.statusImpl = () => Promise.reject(new Error('sqlite closed'))
    const wrapped = await call(ctx, 'code_index_status')
    expect(outcomeErrorCode(wrapped)).toBe(INDEX_TOOL_FAILED)
  })
})

describe('refresh_code_index execution', () => {
  it('performs an incremental pass by default and maps forced rebuilds', async () => {
    const { ctx, index } = await setup()
    const incremental = await call(ctx, 'refresh_code_index')
    expect(incremental.isError).toBe(false)
    expect(incremental.content).toContain('reason: manual')
    expect(outcomeValue(incremental)).toMatchObject({ changedFiles: 3, removedFiles: 1 })

    const forced = await call(ctx, 'refresh_code_index', { force: true })
    expect(forced.content).toContain('chunksWritten: 17')
    expect(index.refreshes[0]!.forceRebuild).toBe(false)
    expect(index.refreshes[1]!.forceRebuild).toBe(true)
  })

  it('answers a concurrent tool-driven refresh with the structured busy code instead of queueing', async () => {
    const { ctx, index } = await setup()
    let release!: (summary: RefreshSummary) => void
    const gate = new Promise<RefreshSummary>((resolve) => {
      release = resolve
    })
    let released = false
    index.refreshImpl = async () => {
      if (!released) {
        released = true
        return gate
      }
      return {
        reason: 'manual',
        changedFiles: 0,
        removedFiles: 0,
        chunksWritten: 0,
        durationMs: 1,
        epochsAfter: { indexEpoch: 5, evidenceEpoch: 0 },
      }
    }

    const first = ctx.tools.execute({
      signal: TEST_SIGNAL,
      callId: CallId('busy-first'),
      name: 'refresh_code_index',
      arguments: {},
      agent: { session: { header: { cwd: process.cwd() } } } as never,
    })
    // Wait until the first pass actually entered execute (busy counter set).
    for (let spins = 0; index.refreshes.length === 0 && spins < 500; spins += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const busy = await call(ctx, 'refresh_code_index')
    expect(busy.isError).toBe(true)
    expect(outcomeErrorCode(busy)).toBe(INDEX_TOOL_REFRESH_IN_PROGRESS)

    release({
      reason: 'manual',
      changedFiles: 1,
      removedFiles: 0,
      chunksWritten: 2,
      durationMs: 3,
      epochsAfter: { indexEpoch: 5, evidenceEpoch: 0 },
    })
    const summary = await first
    expect(summary.isError).toBe(false)

    // The try/finally guard releases the pass even when the provider rejects.
    let rejectedOnce = false
    index.refreshImpl = () => {
      if (!rejectedOnce) {
        rejectedOnce = true
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve({
        reason: 'manual',
        changedFiles: 0,
        removedFiles: 0,
        chunksWritten: 1,
        durationMs: 2,
        epochsAfter: { indexEpoch: 6, evidenceEpoch: 0 },
      })
    }
    const failing = await call(ctx, 'refresh_code_index')
    expect(outcomeErrorCode(failing)).toBe(INDEX_TOOL_FAILED)

    const recovered = await call(ctx, 'refresh_code_index')
    expect(outcomeErrorCode(recovered)).toBeUndefined()
    expect(recovered.isError).toBe(false)
  })

  it('advances the epoch visibly from refresh into the next status report', async () => {
    const { ctx } = await setup()
    const refreshed = await call(ctx, 'refresh_code_index')
    expect(outcomeValue(refreshed)).toMatchObject({ epochsAfter: { indexEpoch: 5 } })
    const after = await call(ctx, 'code_index_status')
    expect(outcomeValue(after)).toMatchObject({ epochs: { indexEpoch: 5 } })
    expect(after.content).toContain('indexEpoch: 5')
    expect(renderRefreshOutput(outcomeValue(refreshed) as Parameters<typeof renderRefreshOutput>[0])).toContain('indexEpoch now: 5')
  })

  it('reports missing providers structurally', async () => {
    const outcome = await call((await setup({ withProvider: false })).ctx, 'refresh_code_index')
    expect(outcomeErrorCode(outcome)).toBe(INDEX_TOOL_UNAVAILABLE)
  })
})

describe('presenters are pure functions of args plus the result', () => {
  it('projects pending and completed views for every tool', () => {
    expect(presentSearchCall({ query: 'ledger' })).toEqual({
      card: 'generic',
      title: 'CodeIndex search: ledger',
      kind: 'search',
      rawInput: 'ledger',
    })
    expect(presentSearchResult({ query: 'ledger' }, { isError: true } as ToolResult)).toBeUndefined()
    expect(presentSearchResult({ query: 'ledger' }, { isError: false } as ToolResult)).toEqual({
      card: 'generic',
      title: 'search_code_index · "ledger"',
    })
    expect(presentStatusCall()).toEqual({ card: 'generic', title: 'CodeIndex status', kind: 'read' })
    expect(presentStatusResult({}, { isError: true } as unknown as ToolResult)).toBeUndefined()
    expect(presentStatusResult({}, { isError: false } as unknown as ToolResult)).toEqual({ card: 'generic', title: 'code_index_status' })
    expect(presentRefreshCall({ force: true }).title).toContain('forced')
    expect(presentRefreshCall({}).title).toBe('CodeIndex refresh')
    expect(presentRefreshResult({}, { isError: true } as unknown as ToolResult)).toBeUndefined()
    expect(presentRefreshResult({}, { isError: false } as unknown as ToolResult)).toEqual({ card: 'generic', title: 'refresh_code_index' })
  })

  it('keeps rendering helpers deterministic', () => {
    const hit = fixtureSearch().hits[0]!
    expect(formatSearchHit(hit)).toBe('src/a.ts:10-24 7.25 exact identifier,recent file')
    expect(isTruncationEnvelope({ _truncated: true })).toBe(true)
    expect(isTruncationEnvelope({})).toBe(false)
    expect(isTruncationEnvelope(null)).toBe(false)
    expect(renderSearchOutput(fixtureSearch())).toContain('Query "parse ledger" (tiny tier)')
  })
})

describe('invariant companion', () => {
  it('keeps the companion module surface loader-safe (registration lives in the focused suite)', async () => {
    const mod = await import('../src/invariant.ts')
    expect(mod.name).toBe('tool-code-index-invariant')
    expect(mod.inject).toEqual(['invariants'])
    expect(typeof mod.apply).toBe('function')
  })
})
