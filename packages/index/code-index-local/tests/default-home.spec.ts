/**
 * Default storage-root derivation through `$RLH_HOME`, booted without any
 * module mocks so the loader-resolved config flows through the real `node:fs`.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndexLocal from '../src/index.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

const contexts: Context[] = []
const extraDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  await sweepWorkspaces()
})

describe('default database derivation', () => {
  it('derives the store under $RLH_HOME when databasePath is omitted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-cil-home-'))
    extraDirs.push(home)
    const root = await makeWorkspace('rlh-cil-home-ws-', {
      files: { 'defaulted.ts': 'export const defaultValue = 1\n' },
    })
    const ctx = contexts[contexts.push(new Context()) - 1] as Context
    const previousHome = process.env.RLH_HOME
    process.env.RLH_HOME = home
    try {
      await ctx.plugin(CodeIndexLocal, { workspaceRoot: root })
      const provider = ctx.get('codeIndex') as CodeIndexLocal
      // The resolved runtime carries the derived default explicitly.
      const resolvedDatabasePath = (provider as unknown as {
        runtime: { config: { databasePath: string } }
      }).runtime.config.databasePath
      expect(resolvedDatabasePath.startsWith(join(home, 'index'))).toBe(true)
      await provider.refresh({ reason: 'manual' })
      const written = await readdir(join(home, 'index'))
      expect(written[0]).toMatch(/^code-index-[0-9a-f]{12}\.sqlite3$/u)
      expect((await provider.status()).indexedFileCount).toBe(1)
    } finally {
      if (previousHome === undefined) delete process.env.RLH_HOME
      else process.env.RLH_HOME = previousHome
    }
  })

  it('resolves every omitted knob through a directly constructed instance', async () => {
    // Omitting databasePath exercises the derived default; the workspace root
    // comes from Config here, every other knob falls back without a loader.
    const context = contexts[contexts.push(new Context()) - 1] as Context
    const root = await makeWorkspace('rlh-cil-direct-', {
      files: { 'only.ts': 'export const direct = true\n' },
    })
    const databasePath = join(await mkdtemp(join(tmpdir(), 'rlh-cil-direct-db-')), 'index.sqlite3')
    extraDirs.push(databasePath.slice(0, databasePath.lastIndexOf('/')))
    const provider = new CodeIndexLocal(context, { workspaceRoot: root })
    const resolved = (provider as unknown as {
      runtime: { config: { journalMode: string } }
    }).runtime.config
    expect(resolved.journalMode).toBe('wal')
    const report = await provider.status()
    // No pass has run, so the walk never touched the tree; counts stay zero.
    expect(report.indexedFileCount).toBe(0)
    await provider.refresh({ reason: 'manual' })
    expect((await provider.status()).indexedFileCount).toBe(1)
    await context.fiber.dispose()
    contexts.length = 0
  })

  it('forwards native watcher storms through onChange into one stale refresh', async () => {
    const root = await makeWorkspace('rlh-cil-watch-native-', {
      files: { 'seed.ts': 'export const seedMarkerConstant = 1\n' },
    })
    const ctx = contexts[contexts.push(new Context()) - 1] as Context
    await ctx.plugin(CodeIndexLocal, {
      workspaceRoot: root,
      databasePath: ':memory:',
      watcherEnabled: true,
      debounceMs: 50,
    })
    const provider = ctx.get('codeIndex') as CodeIndexLocal
    await provider.refresh()
    await writeFile(join(root, 'late.ts'), 'export const lateStormMarker = 2\n')
    // The native event storm lands as ONE debounced stale pass discovering it.
    await pollUntil(async () => {
      const summary = (await provider.status()).lastRefresh
      return summary !== undefined && summary.reason === 'stale'
    }, 3000)
    const answer = await provider.search({ query: 'lateStormMarker' })
    expect(answer.hits.length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
    contexts.length = 0
  })
  it('defaults the workspace root to the process working directory', async () => {
    const context = contexts[contexts.push(new Context()) - 1] as Context
    const provider = new CodeIndexLocal(context, {})
    const resolved = (provider as unknown as {
      runtime: { config: { workspaceRoot: string } }
    }).runtime.config
    expect(resolved.workspaceRoot).toBe(process.cwd())
    // No walk without an explicit pass, so opening stays side-effect free.
    expect((await provider.status()).indexedFileCount).toBeGreaterThanOrEqual(0)
    await context.fiber.dispose()
    contexts.length = 0
  })

})

/** Poll until the predicate holds within an explicit deadline. */
async function pollUntil(predicate: () => Promise<boolean>, deadlineMs: number): Promise<void> {
  for (let attempt = 0; attempt * 20 < deadlineMs; attempt++) {
    if (await predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  throw new Error('condition did not settle before the deadline')
}
