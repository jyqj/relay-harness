import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import ContextEngine from '@relay-harness/rlh-context-engine'
import { createUserMessage } from '@relay-harness/rlh-llm'
import McpCatalog from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(ContextEngine)
  await ctx.plugin(McpCatalog)
  return ctx
}

describe('McpCatalog', () => {
  it('publishes protocol-native resources/templates/prompts and invokes them explicitly', async () => {
    const ctx = await bench()
    const readResource = vi.fn(() => Promise.resolve({ contents: [{ uri: 'docs://guide', text: 'guide body', mimeType: 'text/plain' }] }))
    const getPrompt = vi.fn(() => Promise.resolve({
      description: 'Review prompt', messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Review this' } }],
    }))
    ctx.mcpCatalog.publish({
      serverName: 'docs',
      resources: [{ uri: 'docs://guide', name: 'Guide', mimeType: 'text/plain' }],
      resourceTemplates: [{ uriTemplate: 'docs://{name}', name: 'Named doc' }],
      prompts: [{ name: 'review', arguments: [{ name: 'target', required: true }] }],
      readResource,
      getPrompt,
    })
    expect(ctx.mcpCatalog.listResources()).toMatchObject([{ serverName: 'docs', uri: 'docs://guide' }])
    expect(ctx.mcpCatalog.listResourceTemplates()).toMatchObject([{ serverName: 'docs', uriTemplate: 'docs://{name}' }])
    expect(ctx.mcpCatalog.listPrompts()).toMatchObject([{ serverName: 'docs', name: 'review' }])
    await expect(ctx.mcpCatalog.readResource('docs', 'docs://guide')).resolves.toMatchObject({ contents: [{ text: 'guide body' }] })
    await expect(ctx.mcpCatalog.getPrompt('docs', 'review', {})).rejects.toThrow(/requires argument target/)
    await expect(ctx.mcpCatalog.getPrompt('docs', 'review', { target: 'src', hidden: 'x' })).rejects.toThrow(/does not declare argument hidden/)
    await expect(ctx.mcpCatalog.getPrompt('docs', 'review', { target: 'src' })).resolves.toMatchObject({ description: 'Review prompt' })
  })

  it('contains one failed explicit Resource while admitting other bounded evidence', async () => {
    const ctx = await bench()
    ctx.mcpCatalog.publish({
      serverName: 'docs',
      resources: [{ uri: 'docs://broken', name: 'Broken' }, { uri: 'docs://good', name: 'Good' }],
      resourceTemplates: [], prompts: [],
      readResource: async (uri) => {
        if (uri === 'docs://broken') throw new Error('offline')
        return { contents: [{ uri, text: 'trusted only as data' }] }
      },
      getPrompt: async () => ({ messages: [] }),
    })
    const prepared = await ctx.contextEngine.prepareStep({
      purpose: 'agent_step', cwd: '/workspace', signal: new AbortController().signal,
      caller: { sessionId: 's' as never, agentId: 's', workspaceId: '/workspace' },
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use docs://broken and docs://good' }] })],
    })
    expect(prepared?.evidence).toHaveLength(1)
    expect(prepared?.coverage[0]).toMatchObject({
      searched: ['docs:docs://good'],
      notSearched: ['docs:docs://broken:read-failed'],
      completeness: 'bounded',
    })
  })

  it('bounds Prompt arguments/results and rejects malformed catalog URIs', async () => {
    const ctx = new Context(); await ctx.plugin(McpCatalog, { maxPromptBytes: 64, maxPromptArgumentChars: 4 })
    ctx.mcpCatalog.publish({
      serverName: 'prompts', resources: [], resourceTemplates: [],
      prompts: [{ name: 'review', arguments: [{ name: 'x', required: true }] }],
      readResource: async () => ({ contents: [] }),
      getPrompt: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'x'.repeat(128) } }] }),
    })
    await expect(ctx.mcpCatalog.getPrompt('prompts', 'review', { x: '12345' })).rejects.toThrow(/exceeds 4 characters/u)
    await expect(ctx.mcpCatalog.getPrompt('prompts', 'review', { x: '1234' })).rejects.toThrow(/maxPromptBytes/u)
    expect(() => ctx.mcpCatalog.publish({
      serverName: 'bad', resources: [{ uri: 'relative', name: 'Bad' }], resourceTemplates: [], prompts: [],
      readResource: async () => ({ contents: [] }), getPrompt: async () => ({ messages: [] }),
    })).toThrow(/must be absolute/u)
  })

  it('hydrates an explicitly mentioned URI through ContextEngine instead of registering a fake tool', async () => {
    const ctx = await bench()
    ctx.mcpCatalog.publish({
      serverName: 'docs',
      resources: [{ uri: 'docs://guide', name: 'Guide', mimeType: 'text/plain' }],
      resourceTemplates: [], prompts: [],
      readResource: () => Promise.resolve({ contents: [{ uri: 'docs://guide', text: 'guide body' }] }),
      getPrompt: () => Promise.reject(new Error('not used')),
    })
    const prepared = await ctx.contextEngine.prepareStep({
      purpose: 'agent_step', cwd: '/workspace', signal: new AbortController().signal,
      caller: { sessionId: 's' as never, agentId: 's', workspaceId: '/workspace' },
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use docs://guide' }] })],
    })
    expect(prepared?.contributions[0]?.contributorId).toBe('mcp-resources')
    const block = prepared?.messages[0]?.content[0]
    expect(block?.type === 'text' && block.text.includes('guide body')).toBe(true)
    expect(prepared?.evidence[0]).toMatchObject({ freshness: 'current', verification: 'verified', resource: { key: 'docs://guide' } })
  })

  it('rejects oversized binary Resources before persistence or context rendering', async () => {
    const ctx = new Context()
    await ctx.plugin(McpCatalog, { maxReadBytes: 8 })
    ctx.mcpCatalog.publish({
      serverName: 'binary', resources: [{ uri: 'bin://large', name: 'Large' }],
      resourceTemplates: [], prompts: [],
      readResource: () => Promise.resolve({ contents: [{ uri: 'bin://large', blob: 'QUFBQUFBQUFB' }] }),
      getPrompt: () => Promise.resolve({ messages: [] }),
    })
    await expect(ctx.mcpCatalog.readResource('binary', 'bin://large')).rejects.toThrow(/maxReadBytes/)
  })

  it('does not resurrect a disposed previous generation when the current generation is disposed', async () => {
    const ctx = await bench()
    const base = {
      resources: [], resourceTemplates: [], prompts: [],
      readResource: () => Promise.resolve({ contents: [] }),
      getPrompt: () => Promise.resolve({ messages: [] }),
    }
    const disposeOld = ctx.mcpCatalog.publish({ serverName: 'x', ...base, prompts: [{ name: 'old', arguments: [] }] })
    const disposeNew = ctx.mcpCatalog.publish({ serverName: 'x', ...base, prompts: [{ name: 'new', arguments: [] }] })
    disposeOld()
    expect(ctx.mcpCatalog.listPrompts()[0]?.name).toBe('new')
    disposeNew()
    expect(ctx.mcpCatalog.listPrompts()).toEqual([])
  })
})
