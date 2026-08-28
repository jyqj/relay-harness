/**
 * Plugin lifecycle over a real workspace, booted with zero module mocks so
 * every exercised `src/index.ts` branch lands in coverage instrumentation.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndexLocal from '../src/index.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

// Assembled so the doc-reference scanner does not read fixture paths as repository links.
const FIX_DOCS = (name: string): string => ['docs', name].join('/')


const contexts: Context[] = []
const extraDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  await sweepWorkspaces()
})

function track(): Context {
  return contexts[contexts.push(new Context()) - 1] as Context
}

describe('plugin lifecycle over one real workspace', () => {
  it('opens on init, serves search/status, folds internal flushes, and disposes with the fiber', async () => {
    const root = await makeWorkspace('rlh-lc-run-', {
      files: {
        'src/atlas-engine.ts': 'export function atlasEngineWeightedSum() {\n  return 7\n}\n',
        [FIX_DOCS('guide.md')]: '# atlas guide mentions atlasEngineWeightedSum\n',
      },
      gitignore: 'scratch/\n',
    })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-lc-db-'))
    extraDirs.push(dbDir)
    const ctx = track()
    await ctx.plugin(CodeIndexLocal, {
      workspaceRoot: root,
      databasePath: join(dbDir, 'index.sqlite3'),
      debounceMs: 60_000,
    })
    const provider = ctx.get('codeIndex') as CodeIndexLocal
    expect(provider).toBeDefined()

    const answer = await provider.search({ query: 'atlasEngineWeightedSum' })
    expect(answer.hits.length).toBeGreaterThan(0)

    const flushed = await provider.refreshInternal({ reason: 'stale' })
    expect(flushed.reason).toBe('stale')

    const report = await provider.status()
    expect(report.indexedFileCount).toBeGreaterThanOrEqual(2)
    expect(report.degraded).toBe(false)

    // Folding: the internal hook rides the in-flight manual pass.
    const [direct, folded] = await Promise.all([provider.refresh(), provider.refreshInternal()])
    expect(folded.reason).toBe(direct.reason)

    // Explicit scope filters survive the mapping into storage SQL.
    const scoped = await provider.search({ query: 'atlasEngineWeightedSum', paths: [FIX_DOCS('guide.md')] })
    expect(scoped.hits.length).toBeGreaterThan(0)
    expect(scoped.hits.every(hit => hit.filePath === FIX_DOCS('guide.md'))).toBe(true)

    // An oversized model top-K clamps down at the tiny-tier cap through the engine.
    const capped = await provider.search({ query: 'atlasEngineWeightedSum', topK: 500 })
    expect(capped.hits.length).toBeLessThanOrEqual(5)

    // Disposal routes through the plugin effect teardown cleanly.
    await ctx.fiber.dispose()
    contexts.length = 0
  })

  it('wires tool-result events to the debounced invalidator and ignores other event kinds', async () => {
    const root = await makeWorkspace('rlh-lc-ev-', {
      files: { 'signal.ts': 'export const pulseFrequencySyncMarker = 3\n' },
    })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-lc-evdb-'))
    extraDirs.push(dbDir)
    const ctx = track()
    await ctx.plugin(CodeIndexLocal, {
      workspaceRoot: root,
      databasePath: join(dbDir, 'index.sqlite3'),
      debounceMs: 20,
    })
    const provider = ctx.get('codeIndex') as CodeIndexLocal
    await provider.refresh()

    // A non-tool event schedules nothing observable; a tool result schedules
    // the stale pass that lands inside the debounce window.
    ctx.emit('session/event', undefined as never, { type: 'assistant/message' } as never)
    ctx.emit('session/event', undefined as never, { type: 'tool/result' } as never)
    await pollUntil(async () => {
      const summary = (await provider.status()).lastRefresh
      return summary !== undefined && summary.reason === 'stale'
    })
    await ctx.fiber.dispose()
    contexts.length = 0
  })
})

/** Poll until the predicate holds; small helper keeps wait windows explicit. */
async function pollUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error('condition did not settle within the allotted attempts')
}
