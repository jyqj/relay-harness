import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import CodeIndexWorkspaceRouter from '@relay-harness/rlh-code-index-workspace-router'
import { CodeIndexCenterGateway } from '@relay-harness/rlh-host-code-index-center'

const temporaryRoots: string[] = []
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('default Web Code Index workspace routing E2E', () => {
  it('switches Sessions while Remote search/status remain isolated by Host-owned cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-web-index-routing-')); temporaryRoots.push(root)
    const workspaceA = join(root, 'a'); const workspaceB = join(root, 'b'); const databases = join(root, 'db')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB), mkdir(databases)])
    await Promise.all([
      writeFile(join(workspaceA, 'only-a.ts'), 'export const heliotropeWorkspaceA = 1\n'),
      writeFile(join(workspaceB, 'only-b.py'), 'def cobalt_workspace_b():\n    return 2\n'),
    ])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CodeIndexWorkspaceRouter, { databaseDirectory: databases, maxOpenWorkspaces: 2, idleEvictMs: 60_000 })
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
    } finally { await ctx.fiber.dispose() }
  })
})
