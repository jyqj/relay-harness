import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndexWorkspaceRouter from '../src/index.ts'

const roots: string[] = []
async function fixture(): Promise<{ root: string; a: string; b: string; db: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-code-index-router-'))
  roots.push(root)
  const a = join(root, 'workspace-a')
  const b = join(root, 'workspace-b')
  const db = join(root, 'indexes')
  await Promise.all([mkdir(a), mkdir(b), mkdir(db)])
  await Promise.all([
    writeFile(join(a, 'alpha.ts'), 'export function alphaQuantaOnly() { return 11 }\n'),
    writeFile(join(b, 'beta.ts'), 'export function betaNebulaOnly() { return 22 }\n'),
  ])
  return { root, a, b, db }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup(db: string, maxOpenWorkspaces = 4, idleEvictMs = 60_000): Promise<{ ctx: Context; router: CodeIndexWorkspaceRouter }> {
  const ctx = new Context()
  await ctx.plugin(CodeIndexWorkspaceRouter, {
    databaseDirectory: db,
    maxOpenWorkspaces,
    idleEvictMs,
    watcherEnabled: false,
  })
  return { ctx, router: ctx.codeIndex as CodeIndexWorkspaceRouter }
}

describe('workspace isolation and lifecycle', () => {
  it('indexes two real workspaces concurrently without cross-workspace search or hydration', async () => {
    const { a, b, db } = await fixture()
    const { ctx, router } = await setup(db)
    try {
      const [aIndex, bIndex] = await Promise.all([router.forWorkspace(a), router.forWorkspace(b)])
      const [alpha, beta] = await Promise.all([
        aIndex.search({ query: 'alphaQuantaOnly' }),
        bIndex.search({ query: 'betaNebulaOnly' }),
      ])
      expect(alpha.hits.map(hit => hit.filePath)).toEqual(['alpha.ts'])
      expect(beta.hits.map(hit => hit.filePath)).toEqual(['beta.ts'])
      expect((await aIndex.search({ query: 'betaNebulaOnly' })).hits).toEqual([])
      expect((await bIndex.search({ query: 'alphaQuantaOnly' })).hits).toEqual([])
      const chunkId = alpha.hits[0]?.chunkId as string
      expect((await aIndex.hydrateChunks({ chunkIds: [chunkId] })).chunks[0]?.text).toContain('alphaQuantaOnly')
      expect(await bIndex.hydrateChunks({ chunkIds: [chunkId] })).toMatchObject({
        chunks: [],
        rejected: [{ chunkId, state: 'unavailable', reason: 'not-indexed' }],
      })
      expect(router.databasePathFor(a)).not.toBe(router.databasePathFor(b))
      expect(router.openWorkspaceRoots()).toEqual([aIndex.workspaceRoot, bIndex.workspaceRoot].sort())
    } finally { await ctx.fiber.dispose() }
  })

  it('collapses a symlink alias to one canonical identity and one derived store', async () => {
    const { root, a, db } = await fixture()
    const alias = join(root, 'alias-a')
    await symlink(a, alias, 'dir')
    const { ctx, router } = await setup(db)
    try {
      const [direct, throughAlias] = await Promise.all([router.forWorkspace(a), router.forWorkspace(alias)])
      expect(throughAlias.workspaceRoot).toBe(direct.workspaceRoot)
      await Promise.all([direct.status(), throughAlias.status()])
      expect(router.openWorkspaceRoots()).toEqual([direct.workspaceRoot])
      expect(router.databasePathFor(direct.workspaceRoot)).toBe(router.databasePathFor(throughAlias.workspaceRoot))
    } finally { await ctx.fiber.dispose() }
  })

  it('evicts the least-recent quiescent runtime and reopens its durable generation', async () => {
    const { a, b, db } = await fixture()
    const { ctx, router } = await setup(db, 1)
    try {
      const aIndex = await router.forWorkspace(a)
      const first = await aIndex.search({ query: 'alphaQuantaOnly' })
      expect(first.hits).toHaveLength(1)
      const epoch = first.epochs.indexEpoch
      await (await router.forWorkspace(b)).search({ query: 'betaNebulaOnly' })
      await router.evictIdleNow()
      expect(router.openWorkspaceRoots()).toEqual([])
      const reopened = await (await router.forWorkspace(a)).search({ query: 'alphaQuantaOnly' })
      expect(reopened.hits).toHaveLength(1)
      expect(reopened.epochs.indexEpoch).toBe(epoch)
    } finally { await ctx.fiber.dispose() }
  })

  it('waits for an active lease before close and evicts an actually idle runtime on its timer', async () => {
    const { a, db } = await fixture()
    const { ctx, router } = await setup(db, 4, 20)
    try {
      const handle = await router.forWorkspace(a)
      await handle.status()
      const internal = router as unknown as {
        entries: Map<string, { runtime: { search: typeof handle.search } }>
      }
      const entry = [...internal.entries.values()][0]!
      const original = entry.runtime.search.bind(entry.runtime)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      entry.runtime.search = async (request, signal) => { await gate; return original(request, signal) }
      const active = handle.search({ query: 'alphaQuantaOnly' })
      await Promise.resolve()
      await router.evictIdleNow()
      expect(router.openWorkspaceRoots()).toEqual([handle.workspaceRoot])
      release(); await active
      for (let attempt = 0; router.openWorkspaceRoots().length > 0 && attempt < 50; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(router.openWorkspaceRoots()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects every unscoped process-wide operation instead of selecting a prior workspace', async () => {
    const { db } = await fixture()
    const { ctx, router } = await setup(db)
    try {
      await expect(router.status()).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.search({ query: 'anything' })).rejects.toThrow('bind an explicit Session workspace')
    } finally { await ctx.fiber.dispose() }
  })
})
