/**
 * Real-composition acceptance: the local provider, the code-index tools, and
 * their service prerequisites boot together from a test-only cordis.yml through
 * the actual Loader + Include path; a `search_code_index` tool call ranks real
 * fixture files (with the graph rerank visible on the canonical value) while
 * every excluded decoy stays invisible, and `explore_code_graph` reads the
 * cross-file call chain and the path-derived test pairs out of the same store.
 * An on-disk edit, deletion, and the deterministic invalidation hook then prove
 * incremental freshness and epoch advancement without waiting on debounces.
 */

import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include from '@relay-harness/cordis-plugin-include'
import { CallId } from '@relay-harness/rlh-llm'
import SystemPromptService from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import CodeIndexLocal from '../src/index.ts'
import type { CodeIndexLocal as CodeIndexLocalType } from '../src/index.ts'

// Assembled so the doc-reference scanner does not read fixture paths as repository links.
const FIX_DOCS = (name: string): string => ['docs', name].join('/')


const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function buildFixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-cil-composition-'))
  roots.push(root)
  const files: Readonly<Record<string, string>> = {
    'README.md': '# 演示工作区\n\nContains the spoolQuantaMarker protocol.\n',
    'src/engine.ts': [
      'export function spoolQuantaMarker(): number {',
      '  return 20260827',
      '}',
      '',
    ].join('\n'),
    'src/pump.ts': [
      "import { spoolQuantaMarker } from './engine'",
      '',
      'export function pumpCycle(): number {',
      '  return spoolQuantaMarker()',
      '}',
      '',
    ].join('\n'),
    'src/nested/deep_grove.py': [
      'def deepGroveRotor(cycles):',
      '    """青花瓷 rotor scheduler."""',
      '    return cycles * 3',
      '',
    ].join('\n'),
    [FIX_DOCS('manual.md')]: '手册：spoolQuantaMarker 必须先于 deepGroveRotor 校准。\n',
    'tests/spool.test.ts': "test('spool', () => expect(spoolQuantaMarker()).toBeGreaterThan(0))\n",
    'tests/engine.test.ts': "import { spoolQuantaMarker } from '../src/engine'\ntest('engine', () => {\n  expect(spoolQuantaMarker()).toBeGreaterThan(0)\n})\n",
    'notes/telemetry.yaml': 'frequency: 42\ncall: spoolQuantaMarker\n',
  }
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(root, relPath)
    await mkdir(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true })
    await writeFile(absolute, contents)
  }
  // Decoys inside trees that must never enter the index.
  await writeFile(join(root, '.gitignore'), 'legacy/\n')
  await mkdir(join(root, 'legacy'), { recursive: true })
  await writeFile(join(root, 'legacy/spool-decoy.js'), 'export const spoolQuantaMarker = () => 0\n')
  await mkdir(join(root, 'target/vendor'), { recursive: true })
  await writeFile(join(root, 'target/vendor/spool-hard-bait.ts'), 'export const spoolQuantaMarkerHardBait = 1\n')
  return root
}

async function loadComposition(workspaceRoot: string): Promise<void> {
  const configPath = join(workspaceRoot, 'cordis.yml')
  await writeFile(configPath, [
    '- id: system-prompt',
    "  name: '@relay-harness/rlh-system-prompt'",
    '- id: tools',
    "  name: '@relay-harness/rlh-tools'",
    '- id: index-local',
    "  name: '@relay-harness/rlh-code-index-local'",
    '  config:',
    `    workspaceRoot: ${JSON.stringify(workspaceRoot)}`,
    `    databasePath: ${JSON.stringify(join(workspaceRoot, '.rlh-store', 'index.sqlite3'))}`,
    '    debounceMs: 20000',
    '- id: tool-code-index',
    "  name: '@relay-harness/rlh-tool-code-index'",
    '',
  ].join('\n'))

  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-system-prompt', SystemPromptService],
    ['@relay-harness/rlh-tools', ToolRuntime],
    ['@relay-harness/rlh-code-index-local', CodeIndexLocal],
    // The consumer is loaded straight from source by its namespace shape.
    ['@relay-harness/rlh-tool-code-index', await import('@relay-harness/rlh-tool-code-index/src/index.ts')],
  ])

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(workspaceRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
}

interface ExecuteOutcome {
  readonly text: string
  readonly value: unknown
}

async function executeTool(name: string, args: Record<string, unknown> = {}): Promise<ExecuteOutcome> {
  const settled: unknown[] = []
  const listener = (_exec: unknown, result: { readonly value?: unknown }): void => {
    settled.push(result.value)
  }
  const dispose = context?.on('tools/result', listener as never) as (() => void) | undefined
  try {
    const result = await context?.tools.execute({
      callId: CallId(`composition-${Math.random().toString(36).slice(2)}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
    return {
      text: (result?.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
      value: settled.at(-1),
    }
  } finally {
    dispose?.()
  }
}

async function executeSearch(query: string, extraArgs: Record<string, unknown> = {}): Promise<ExecuteOutcome> {
  return executeTool('search_code_index', { query, ...extraArgs })
}

describe('code-index-local real composition', () => {
  it('boots provider + tools through cordis.yml, keeps excluded decoys invisible, and proves incremental freshness with epoch advancement', async () => {
    const root = await buildFixtureTree()
    await loadComposition(root)

    const provider = context?.get('codeIndex') as CodeIndexLocalType | undefined
    if (provider === undefined) throw new Error('provider never registered')

    // First search goes through the lazy path inside the tool execution.
    const first = await executeSearch('spoolQuantaMarker')
    expect(first.text).toContain('src/engine.ts')
    expect(first.text).toContain('tests/spool.test.ts')
    for (const forbidden of ['legacy/', 'target/', 'spool-decoy', 'spool-hard-bait']) {
      expect(first.text).not.toContain(forbidden)
    }

    // The graph-aware path is live on the canonical value: at least one hit
    // resolved to a symbol and carries its connectivity score plus the rerank
    // reason token.
    const enriched = (first.value as { hits?: Array<{ graphScore?: number; reasons?: string[] }> } | undefined)?.hits ?? []
    expect(enriched.some(hit => hit.graphScore !== undefined && hit.reasons?.includes('boost:graph-rerank'))).toBe(true)

    // explore_code_graph walks the real cross-file call chain: pumpCycle is a
    // caller of spoolQuantaMarker (alongside the declaration self-loop the
    // parser's fallback lane records).
    const callers = await executeTool('explore_code_graph', { op: 'relations', symbol: 'spoolQuantaMarker', direction: 'callers' })
    expect(callers.text).toContain('relations explore (tiny tier)')
    expect(callers.text).toContain('caller: pumpCycle → spoolQuantaMarker (src/pump.ts:4)')
    expect(callers.text).toContain('explain: declared=[CALLS] candidates=2')

    const statusAfterFirst = await provider.status()
    const firstEpoch = statusAfterFirst.epochs.indexEpoch
    expect(firstEpoch).toBeGreaterThanOrEqual(1)
    expect(statusAfterFirst.indexedFileCount).toBeGreaterThanOrEqual(8)

    // Incremental phase: edit one file, delete another, flush deterministically.
    await writeFile(join(root, 'src/engine.ts'), [
      'export function spoolQuantaMarker(): number {',
      '  return emberFrostRecalibration()',
      '}',
      '',
      'function emberFrostRecalibration(): number {',
      '  return 9001',
      '}',
      '',
    ].join('\n'))
    await unlink(join(root, 'src/nested/deep_grove.py'))
    await provider.refreshInternal({ reason: 'stale' })

    const statusAfterDelta = await provider.status()
    expect(statusAfterDelta.epochs.indexEpoch).toBeGreaterThan(firstEpoch)

    const added = await executeSearch('emberFrostRecalibration')
    expect(added.text).toContain('src/engine.ts')

    const deleted = await executeSearch('deepGroveRotor')
    expect(deleted.text).not.toContain('deep_grove.py')

    // Exclusion guarantees still hold after the delta pass.
    const afterDelta = await executeSearch('spoolQuantaMarker')
    expect(afterDelta.text).not.toContain('legacy/')
    expect(afterDelta.text).not.toContain('target/')

    // The incremental pass rewrote engine.ts, so the path-derived test-edge
    // rebuild committed its pair and op=tests reads it back through the tool.
    const tests = await executeTool('explore_code_graph', { op: 'tests', files: ['src/engine.ts'] })
    expect(tests.text).toContain('test: tests/engine.test.ts → src/engine.ts (same-basename)')
  })

  it('measures the first full-index pass over the fixture tree', { timeout: 60_000 }, async () => {
    const durations: number[] = []
    let fileCount = 0
    for (let run = 0; run < 3; run += 1) {
      const root = await buildFixtureTree()
      await loadComposition(root)
      const provider = context?.get('codeIndex') as CodeIndexLocalType | undefined
      if (provider === undefined) throw new Error('provider never registered')
      const summary = await provider.refreshInternal({ reason: 'manual' })
      durations.push(summary.durationMs)
      fileCount = (await provider.status()).indexedFileCount
      await context?.fiber.dispose()
      context = undefined
    }
    durations.sort((left, right) => left - right)
    const median = durations[1] as number
    const perFile = median / fileCount
    console.info(`[perf] code-index-local first full index (fixture, ${fileCount} files): passes=${durations.join('/')}ms median=${median}ms (${perFile.toFixed(2)} ms/file)`)
    expect(fileCount).toBeGreaterThanOrEqual(8)
    expect(median).toBeGreaterThan(0)
  })
})
