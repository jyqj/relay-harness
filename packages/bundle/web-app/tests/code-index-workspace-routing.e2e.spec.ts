import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include, { entryListSchema } from '@relay-harness/cordis-plugin-include'
import * as yaml from 'js-yaml'
import ContextEngine from '@relay-harness/rlh-context-engine'
import CodeContext from '@relay-harness/rlh-code-context'
import { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import CodeIndexWorkspaceRouter from '@relay-harness/rlh-code-index-workspace-router'
import { CodeIndexCenterGateway } from '@relay-harness/rlh-host-code-index-center'

const temporaryRoots: string[] = []
let context: Context | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface PatchRow {
  readonly id: string
  readonly name: string
  readonly config?: unknown
}

async function shippedIndexRows(): Promise<readonly PatchRow[]> {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patches = yaml.load(text, { schema: entryListSchema }) as Array<{ insert?: PatchRow[] }>
  const rows = patches.flatMap(patch => patch.insert ?? [])
  return ['code-index-workspace-router', 'code-context'].map((id) => {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`shipped Web patch is missing ${id}`)
    return row
  })
}

describe('default Web Code Index workspace routing E2E', () => {
  it('boots shipped provider/contributor rows and prepares verified source through the real Loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-web-index-routing-')); temporaryRoots.push(root)
    const workspaceA = join(root, 'a'); const workspaceB = join(root, 'b')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)])
    await Promise.all([
      writeFile(join(workspaceA, 'only-a.ts'), 'export const heliotropeWorkspaceA = 1\n'),
      writeFile(join(workspaceB, 'only-b.py'), 'def cobalt_workspace_b():\n    return 2\n'),
    ])
    const [routerRow, codeContextRow] = await shippedIndexRows()
    expect(codeContextRow?.config).toEqual({ maxChars: 65_536, maxHits: 8, minQueryChars: 8 })
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, yaml.dump([
      { id: 'session', name: '@relay-harness/rlh-session' },
      { id: 'context-engine', name: '@relay-harness/rlh-context-engine' },
      routerRow,
      codeContextRow,
    ], { noRefs: true }))
    vi.stubEnv('RLH_HOME', join(root, 'home'))
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@relay-harness/rlh-session', SessionStore],
      ['@relay-harness/rlh-context-engine', ContextEngine],
      ['@relay-harness/rlh-code-index-workspace-router', CodeIndexWorkspaceRouter],
      ['@relay-harness/rlh-code-context', CodeContext],
    ])
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
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const gateway = new CodeIndexCenterGateway(ctx)
    ctx.sessions.create(SessionId('session-a'), { meta: { cwd: workspaceA } })
    ctx.sessions.create(SessionId('session-b'), { meta: { cwd: workspaceB } })
    try {
      const a = await gateway.search({ sessionId: 'session-a', query: 'heliotropeWorkspaceA', topK: 5 })
      const b = await gateway.search({ sessionId: 'session-b', query: 'cobalt_workspace_b', topK: 5 })
      expect(a.result.hits.map(hit => hit.filePath)).toEqual(['only-a.ts'])
      expect(b.result.hits.map(hit => hit.filePath)).toEqual(['only-b.py'])
      const crossProbe = await gateway.search({ sessionId: 'session-b', query: 'heliotropeWorkspaceA' })
      expect(crossProbe.result.hits.every(hit => hit.filePath === 'only-b.py')).toBe(true)
      expect(crossProbe.result.hits.some(hit => hit.filePath === 'only-a.ts')).toBe(false)
      const [statusA, statusB] = await Promise.all([
        gateway.status({ sessionId: 'session-a' }), gateway.status({ sessionId: 'session-b' }),
      ])
      expect(statusA.workspaceRoot).not.toBe(statusB.workspaceRoot)
      expect(statusA.indexedFileCount).toBe(1); expect(statusB.indexedFileCount).toBe(1)

      const prepared = await ctx.contextEngine.prepareStep({
        purpose: 'agent_step',
        messages: [createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Show the heliotropeWorkspaceA implementation.' }],
        })],
        signal: new AbortController().signal,
        cwd: workspaceA,
        caller: {
          sessionId: SessionId('session-a'),
          agentId: 'session-a',
          workspaceId: workspaceA,
          turn: 1,
          step: 1,
        },
      })
      expect(prepared?.contributions).toHaveLength(1)
      expect(prepared?.contributions[0]).toMatchObject({
        contributorId: 'code-index-recall',
        evidence: [{ freshness: 'current', verification: 'verified' }],
      })
      const hydratedTexts = prepared?.messages.flatMap(message => message.content.flatMap(
        block => block.type === 'text' ? [block.text] : [],
      )) ?? []
      expect(hydratedTexts.some(text => text.includes('heliotropeWorkspaceA = 1'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      context = undefined
    }
  })
})
