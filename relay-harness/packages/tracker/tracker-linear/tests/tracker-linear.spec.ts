import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import TrackerRegistry from '@relay-harness/rlh-tracker'
import type { JsonValue } from '@relay-harness/rlh-session'
import { apply, Config, LinearTrackerProvider } from '../src/index.ts'

const baseIssue = {
  id: 'linear-1',
  identifier: 'ENG-1',
  title: 'Automate this issue',
  description: 'body',
  priority: 2,
  state: { name: 'Todo' },
  branchName: 'eng-1',
  url: 'https://linear.app/issue/ENG-1',
  assignee: { id: 'user-1' },
  labels: { nodes: [{ name: ' Agent ' }] },
  inverseRelations: { nodes: [] },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

function provider(overrides: Record<string, unknown> = {}) {
  return new LinearTrackerProvider({
    providerName: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'secret',
    apiKeyEnv: 'LINEAR_API_KEY',
    projectSlug: 'project',
    assignee: 'user-1',
    terminalStates: ['Done'],
    blockNewStates: ['Todo'],
    ...overrides,
  })
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('LinearTrackerProvider', () => {
  it('paginates state reads and normalizes routing fields', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [{ ...baseIssue, id: `linear-${calls}`, identifier: `ENG-${calls}` }],
            pageInfo: calls === 1
              ? { hasNextPage: true, endCursor: 'next' }
              : { hasNextPage: false, endCursor: null },
          },
        },
      }), { status: 200 })
    }))
    const issues = await provider().fetchIssuesByStates(['Todo'])
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ identifier: 'ENG-1', labels: ['agent'], dispatchable: true })
    expect(calls).toBe(2)
  })

  it('marks new issues with non-terminal blockers as not dispatchable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [{
            ...baseIssue,
            inverseRelations: { nodes: [{ type: 'blocks', issue: { id: 'blocker', state: { name: 'In Progress' } } }] },
          }],
        },
      },
    }), { status: 200 })))
    const [result] = await provider().fetchIssuesByIds(['linear-1' as never])
    expect(result).toMatchObject({ blockedBy: ['blocker'], dispatchable: false })
  })

  it('binds raw GraphQL execution and keeps credential aliases host-side', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: 'secret' })
      return new Response(JSON.stringify({ data: { viewer: { id: 'user-1' } } }), { status: 200 })
    }))
    const binding = provider().bindTools()
    expect(binding.secretEnvironmentNames).toEqual(['LINEAR_API_KEY'])
    await expect(binding.execute(
      'linear_graphql',
      { query: 'query { viewer { id } }' },
      { issue: { ...baseIssue, id: 'linear-1' } as never },
    )).resolves.toMatchObject({ success: true, value: { data: { viewer: { id: 'user-1' } } } })
  })

  it('surfaces bounded HTTP failures without returning the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad'.repeat(1000), { status: 503 })))
    await expect(provider().fetchIssuesByStates(['Todo'])).rejects.toThrow(/HTTP 503/)
    await expect(provider().fetchIssuesByStates(['Todo'])).rejects.not.toThrow(/secret/)
  })

  it('short-circuits empty reads and rejects invalid pagination and response envelopes', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().fetchIssuesByStates([' ', ''])).resolves.toEqual([])
    await expect(provider().fetchIssuesByIds([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: '' } } },
    }), { status: 200 }))
    await expect(provider().fetchIssuesByStates(['Todo'])).rejects.toThrow(/endCursor/)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { status: 200 }))
    await expect(provider().fetchIssuesByStates(['Todo'])).rejects.toThrow(/data must be an object/)
  })

  it('drops malformed candidates, rejects malformed exact reads, and tolerates sparse optional fields', async () => {
    const sparse = {
      id: 'linear-sparse', identifier: 'ENG-S', title: 'Sparse', state: { name: 'In Progress' },
      labels: { nodes: [{}, { name: 'Agent' }] }, inverseRelations: null,
      priority: 'high', createdAt: 'bad', updatedAt: 42,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const payload = JSON.parse(typeof init.body === 'string' ? init.body : '') as { query: string }
      const nodes = payload.query.includes('RlhLinearPoll') ? [null, {}, sparse] : [null]
      return new Response(JSON.stringify({
        data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
      }), { status: 200 })
    }))
    await expect(provider({ assignee: undefined }).fetchIssuesByStates(['In Progress'])).resolves.toEqual([
      expect.objectContaining({
        id: 'linear-sparse', labels: ['agent'], blockedBy: [], dispatchable: true,
      }),
    ])
    await expect(provider().fetchIssuesByIds(['linear-sparse' as never])).rejects.toThrow(/must be an object/)
  })

  it('treats non-array candidate nodes as empty and rejects malformed exact-id envelopes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { issues: { nodes: {}, pageInfo: { hasNextPage: false, endCursor: null } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { issues: { nodes: [{}] } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { issues: { nodes: {} } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().fetchIssuesByStates(['Todo'])).resolves.toEqual([])
    await expect(provider().fetchIssuesByIds(['missing' as never])).rejects.toThrow(/malformed issue/)
    await expect(provider().fetchIssuesByIds(['malformed' as never])).rejects.toThrow(/nodes must be an array/)
    await expect(provider().fetchIssuesByIds(['null-data' as never])).rejects.toThrow(/data must be an object/)
  })

  it('preserves requested id order across batches and omits invisible ids', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `id-${index}`)
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      call += 1
      const payload = JSON.parse(typeof init.body === 'string' ? init.body : '') as { variables: { ids: string[] } }
      const nodes = [...payload.variables.ids].reverse().flatMap(id => id === 'id-10' ? [] : [{
        ...baseIssue, id, identifier: id.toUpperCase(), state: { name: 'In Progress' },
      }])
      return new Response(JSON.stringify({ data: { issues: { nodes } } }), { status: 200 })
    }))
    const result = await provider().fetchIssuesByIds(ids as never)
    expect(result.map(item => item.id)).toEqual(ids.filter(id => id !== 'id-10'))
    expect(call).toBe(2)
  })

  it('resolves the viewer once for me routing and rejects a missing viewer identity', async () => {
    let viewers = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const payload = JSON.parse(typeof init.body === 'string' ? init.body : '') as { query: string }
      if (payload.query.includes('RlhLinearViewer')) {
        viewers += 1
        return new Response(JSON.stringify({ data: { viewer: { id: 'user-1' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        data: { issues: { nodes: [baseIssue], pageInfo: { hasNextPage: false, endCursor: null } } },
      }), { status: 200 })
    }))
    const current = provider({ assignee: 'me' })
    await current.fetchIssuesByStates(['Todo'])
    await current.fetchIssuesByStates(['Todo'])
    expect(viewers).toBe(1)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { viewer: {} } }), { status: 200 })))
    await expect(provider({ assignee: 'me' }).fetchIssuesByStates(['Todo'])).rejects.toThrow(/viewer/)
  })

  it('retries me routing after a transient viewer lookup failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('viewer offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { viewer: { id: 'user-1' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { issues: { nodes: [baseIssue], pageInfo: { hasNextPage: false, endCursor: null } } },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const current = provider({ assignee: 'me' })
    await expect(current.fetchIssuesByStates(['Todo'])).rejects.toThrow(/viewer offline/)
    await expect(current.fetchIssuesByStates(['Todo'])).resolves.toHaveLength(1)
  })

  it('normalizes terminal, missing, and unrelated blocker relations plus assignee mismatch', async () => {
    const relations = [
      { type: 'duplicates', issue: { id: 'ignore', state: { name: 'Todo' } } },
      { type: 'blocks', issue: { state: { name: 'Todo' } } },
      { type: 'blocks', issue: { id: 'done', state: { name: 'Done' } } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { issues: { nodes: [{ ...baseIssue, assignee: { id: 'other' }, inverseRelations: { nodes: relations } }] } },
    }), { status: 200 })))
    const [result] = await provider().fetchIssuesByIds(['linear-1' as never])
    expect(result).toMatchObject({ blockedBy: ['done'], dispatchable: false })
  })

  it('validates every raw tool argument path and maps GraphQL or transport failures', async () => {
    const binding = provider().bindTools()
    const context = { issue: { ...baseIssue, id: 'linear-1' } as never }
    await expect(binding.execute('other', {}, context)).resolves.toMatchObject({ success: false })
    for (const value of [null, [], 'query'] as JsonValue[]) {
      await expect(binding.execute('linear_graphql', value, context)).resolves.toMatchObject({ success: false })
    }
    await expect(binding.execute('linear_graphql', {}, context)).resolves.toMatchObject({ success: false })
    await expect(binding.execute('linear_graphql', { query: 'x', variables: [] }, context)).resolves.toMatchObject({ success: false })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'denied' }] }), { status: 200 })))
    await expect(binding.execute('linear_graphql', { query: 'mutation { x }', variables: null }, context))
      .resolves.toMatchObject({ success: false, value: { errors: [{ message: 'denied' }] } })
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'offline' }))
    await expect(binding.execute('linear_graphql', { query: 'query { x }' }, context))
      .resolves.toEqual({ success: false, value: { error: 'offline' } })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('transport offline') }))
    await expect(binding.execute('linear_graphql', { query: 'query { x }' }, context))
      .resolves.toEqual({ success: false, value: { error: 'transport offline' } })
  })

  it('rejects invalid JSON and GraphQL errors on scheduler reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{', { status: 200 })))
    await expect(provider().fetchIssuesByStates(['Todo'])).rejects.toThrow(/invalid JSON/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 })))
    await expect(provider().fetchIssuesByStates(['Todo'])).rejects.toThrow(/GraphQL errors/)
  })

  it('registers through plugin apply and validates deployment configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(TrackerRegistry)
    vi.stubEnv('LINEAR_TEST_KEY', 'env-secret')
    apply(ctx, Config({ projectSlug: 'project', apiKeyEnv: 'LINEAR_TEST_KEY' }))
    apply(ctx, Config({
      projectSlug: 'project', providerName: 'linear-assigned', apiKey: 'x', assignee: ' user-1 ',
      terminalStates: ['Done'], blockNewStates: ['Todo'], endpoint: 'https://linear.example/graphql',
    }))
    expect(ctx.trackers.list()).toEqual(['linear', 'linear-assigned'])
    expect(() => { apply(ctx, Config({ projectSlug: 'project', providerName: ' ', apiKey: 'x' })) }).toThrow(/providerName/)
    expect(() => { apply(ctx, Config({ projectSlug: 'project', endpoint: 'http://linear.test', apiKey: 'x' })) }).toThrow(/HTTPS/)
    expect(() => { apply(ctx, Config({ projectSlug: 'project', apiKeyEnv: 'MISSING_LINEAR_KEY' })) }).toThrow(/missing API key/)
    expect(() => { apply(ctx, Config({ projectSlug: ' ', apiKey: 'x' })) }).toThrow(/projectSlug/)
    await ctx.fiber.dispose()
  })

  it('forwards caller cancellation to fetch', async () => {
    const signal = new AbortController().signal
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      expect(init.signal).toBe(signal)
      return new Response(JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }), { status: 200 })
    }))
    await provider().fetchIssuesByStates(['Todo'], signal)
  })
})
