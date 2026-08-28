/**
 * Real-Loader composition guard: a test-only cordis.yml boots SystemPrompt,
 * ToolRuntime, a recording CodeIndex provider, and THIS package through the
 * real Cordis plugin Loader, asserting model-visible registration, assembled
 * prompt guidance, and end-to-end seam behavior (search result passthrough,
 * refresh advancing the epoch visible to status).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include from '@relay-harness/cordis-plugin-include'
import { CallId } from '@relay-harness/rlh-llm'
import { CodeIndex } from '@relay-harness/rlh-code-index'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import { renderPrompt } from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import * as toolCodeIndex from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

/** Recording provider: deterministic tiny-tier answer, monotonic refresh epochs. */
class CompositionCodeIndex extends CodeIndex {
  readonly requests: SearchRequest[] = []
  private indexEpoch = 7

  override async status(): Promise<IndexStatusReport> {
    return { indexedFileCount: 42, tier: 'small', epochs: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 }, degraded: false }
  }

  override async refresh(options?: RefreshOptions): Promise<RefreshSummary> {
    void options
    this.indexEpoch += 1
    return {
      reason: 'manual',
      changedFiles: 2,
      removedFiles: 0,
      chunksWritten: 9,
      durationMs: 5,
      epochsAfter: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 },
    }
  }

  override async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request)
    return {
      query: request.query,
      tier: 'small',
      hits: [{
        chunkId: 'chunk:src/ledger.ts:1',
        filePath: 'src/ledger.ts',
        startLine: 3,
        endLine: 30,
        score: 6.5,
        rank: 1,
        reasons: ['exact identifier'],
        parserTier: 'tree-sitter',
        parserConfidence: 0.8,
      }],
      candidateCount: 4,
      epochs: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 },
      truncated: false,
      degraded: false,
      readErrors: [],
    }
  }

  override async exploreGraph(request: GraphExploreRequest): Promise<GraphExploreResult> {
    return {
      op: request.op,
      indexEpoch: { indexEpoch: this.indexEpoch, evidenceEpoch: 0 },
      nodes: [],
      edges: [],
      ...(request.op === 'tests' ? { tests: [] } : {}),
      explain: { declared: request.op === 'relations' ? ['CALLS'] : ['TESTS'], readErrors: [], droppedReadErrorCount: 0 },
      truncated: false,
      candidateCount: 0,
      tier: 'small',
    }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'rlh-tool-code-index-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@relay-harness/rlh-system-prompt'",
    "- name: '@relay-harness/rlh-tools'",
    "- name: 'composition-code-index'",
    "- name: '@relay-harness/rlh-tool-code-index'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-system-prompt', SystemPrompt],
    ['@relay-harness/rlh-tools', ToolRuntime],
    ['composition-code-index', { default: CompositionCodeIndex }],
    ['@relay-harness/rlh-tool-code-index', toolCodeIndex],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

const TEST_SIGNAL = new AbortController().signal

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('boots the consumer over a recording provider with model-visible surface intact', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    // The optional seam resolved because the provider joined the same composition.
    const index = loaded.codeIndex as CompositionCodeIndex
    expect(index).toBeInstanceOf(CompositionCodeIndex)

    const schemaNames = loaded.tools.schemas().map(schema => schema.name).sort()
    expect(schemaNames).toEqual(['code_index_status', 'explore_code_graph', 'refresh_code_index', 'search_code_index'])

    const prompt = renderPrompt(await loaded.systemPrompt.assemble())
    expect(prompt).toContain('Prefer search_code_index over grep/glob')
    expect(prompt).toContain('use explore_code_graph for cross-file structure questions')

    const searchOutcome = await loaded.tools.execute({
      signal: TEST_SIGNAL,
      callId: CallId('loader-search'),
      name: 'search_code_index',
      arguments: { query: 'ledger parser' },
    })
    expect(searchOutcome.isError).toBe(false)
    expect(JSON.stringify(searchOutcome.content)).toContain('src/ledger.ts:3-30')
    expect(index.requests[0]).toMatchObject({ query: 'ledger parser' })

    const exploreOutcome = await loaded.tools.execute({
      signal: TEST_SIGNAL,
      callId: CallId('loader-explore'),
      name: 'explore_code_graph',
      arguments: { op: 'tests', files: ['src/ledger.ts'] },
    })
    expect(exploreOutcome.isError).toBe(false)
    expect(JSON.stringify(exploreOutcome.content)).toContain('tests explore (small tier)')
    expect(JSON.stringify(exploreOutcome.content)).toContain('explain: declared=[TESTS] candidates=0')

    const refreshed = await loaded.tools.execute({
      signal: TEST_SIGNAL,
      callId: CallId('loader-refresh'),
      name: 'refresh_code_index',
      arguments: {},
    })
    expect(refreshed.isError).toBe(false)
    expect(JSON.stringify(refreshed.content)).toContain('indexEpoch now: 8')

    const status = await loaded.tools.execute({
      signal: TEST_SIGNAL,
      callId: CallId('loader-status'),
      name: 'code_index_status',
      arguments: {},
    })
    expect(status.isError).toBe(false)
    expect(JSON.stringify(status.content)).toContain('indexEpoch: 8')
    expect(JSON.stringify(status.content)).toContain('tier: small')
  })
})
