import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import McpCatalog from '@relay-harness/rlh-mcp-catalog'
import { syncCatalog } from '../src/catalog.ts'

describe('MCP catalog synchronization', () => {
  it('fully paginates resources, templates, and prompts and preserves rich reads', async () => {
    const ctx = new Context()
    await ctx.plugin(McpCatalog)
    const client = {
      getServerCapabilities: () => ({ resources: { listChanged: true }, prompts: { listChanged: true } }),
      listResources: vi.fn(async (params?: { cursor?: string }) => params?.cursor === 'r2'
        ? { resources: [{ uri: 'docs://two', name: 'Two' }] }
        : { resources: [{ uri: 'docs://one', name: 'One' }], nextCursor: 'r2' }),
      listResourceTemplates: vi.fn(async (params?: { cursor?: string }) => params?.cursor === 't2'
        ? { resourceTemplates: [{ uriTemplate: 'docs://{two}', name: 'T2' }] }
        : { resourceTemplates: [{ uriTemplate: 'docs://{one}', name: 'T1' }], nextCursor: 't2' }),
      listPrompts: vi.fn(async (params?: { cursor?: string }) => params?.cursor === 'p2'
        ? { prompts: [{ name: 'second' }] }
        : { prompts: [{ name: 'first', arguments: [{ name: 'target', required: true }] }], nextCursor: 'p2' }),
      readResource: vi.fn(async () => ({ contents: [
        { uri: 'docs://one', text: 'body', mimeType: 'text/plain' },
        { uri: 'docs://one.bin', blob: 'AAEC', mimeType: 'application/octet-stream' },
      ] })),
      getPrompt: vi.fn(async () => ({ messages: [
        { role: 'user', content: { type: 'text', text: 'Review', annotations: { audience: ['user'] } } },
        { role: 'assistant', content: { type: 'resource', resource: { uri: 'docs://one', text: 'body', mimeType: 'text/plain' } } },
      ] })),
    }
    const dispose = await syncCatalog(client as never, ctx.mcpCatalog, 'docs')
    expect(ctx.mcpCatalog.listResources().map(item => item.uri)).toEqual(['docs://one', 'docs://two'])
    expect(ctx.mcpCatalog.listResourceTemplates()).toHaveLength(2)
    expect(ctx.mcpCatalog.listPrompts().map(item => item.name)).toEqual(['first', 'second'])
    await expect(ctx.mcpCatalog.readResource('docs', 'docs://one')).resolves.toEqual({ contents: [
      { uri: 'docs://one', text: 'body', mimeType: 'text/plain' },
      { uri: 'docs://one.bin', blob: 'AAEC', mimeType: 'application/octet-stream' },
    ] })
    await expect(ctx.mcpCatalog.getPrompt('docs', 'first', { target: 'x' })).resolves.toMatchObject({
      messages: [{ content: { type: 'text', annotations: { audience: ['user'] } } }, { content: { type: 'resource', resource: { text: 'body' } } }],
    })
    dispose()
    expect(ctx.mcpCatalog.listResources()).toEqual([])
  })

  it('keeps last-good descriptors but refuses reads from a disconnected generation', async () => {
    const ctx = new Context(); await ctx.plugin(McpCatalog)
    let active = true
    const client = {
      getServerCapabilities: () => ({ resources: {} }),
      listResources: async () => ({ resources: [{ uri: 'docs://one', name: 'One' }] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      listPrompts: async () => ({ prompts: [] }),
      readResource: vi.fn(async () => ({ contents: [{ uri: 'docs://one', text: 'body' }] })),
    }
    await syncCatalog(client as never, ctx.mcpCatalog, 'docs', () => active)
    active = false
    expect(ctx.mcpCatalog.listResources()).toHaveLength(1)
    await expect(ctx.mcpCatalog.readResource('docs', 'docs://one')).rejects.toThrow(/disconnected/u)
    expect(client.readResource).not.toHaveBeenCalled()
  })

  it('rejects repeated pagination cursors without replacing the last-good generation', async () => {
    const ctx = new Context()
    await ctx.plugin(McpCatalog)
    ctx.mcpCatalog.publish({ serverName: 'docs', resources: [{ uri: 'stable://one', name: 'Stable' }], resourceTemplates: [], prompts: [], readResource: async () => ({ contents: [] }), getPrompt: async () => ({ messages: [] }) })
    const broken = {
      getServerCapabilities: () => ({ resources: {} }),
      listResources: async () => ({ resources: [], nextCursor: 'same' }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      listPrompts: async () => ({ prompts: [] }),
    }
    await expect(syncCatalog(broken as never, ctx.mcpCatalog, 'docs')).rejects.toThrow(/repeated cursor/)
    expect(ctx.mcpCatalog.listResources()[0]?.uri).toBe('stable://one')
  })
})
