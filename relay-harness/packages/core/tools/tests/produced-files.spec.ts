import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { CallId } from '@relay-harness/rlh-llm'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime, { defineTool } from '@relay-harness/rlh-tools'
import { captureProducedFiles } from '../src/produced-files.ts'

describe('execution-captured declared file mutations', () => {
  it('captures diff and edit locations once but excludes reads and missing presenters', () => {
    expect(captureProducedFiles(() => ({ card: 'diff', title: 'write', diffs: [], locations: [{ path: 'a' }, { path: 'a' }, { path: 'b' }] }), {})).toEqual(['a', 'b'])
    expect(captureProducedFiles(() => ({ card: 'generic', title: 'edit', kind: 'edit', locations: [{ path: 'c' }] }), {})).toEqual(['c'])
    expect(captureProducedFiles(() => ({ card: 'generic', title: 'read', kind: 'read', locations: [{ path: 'a' }] }), {})).toEqual([])
    expect(captureProducedFiles(undefined, {})).toEqual([])
    expect(captureProducedFiles(() => ({ card: 'diff', title: 'unlocated edit', diffs: [] }), {})).toEqual([])
    expect(captureProducedFiles(() => { throw new Error('presenter failed') }, {})).toBeUndefined()
  })

  it('freezes capture, preserves it through post-execute replacement, and keeps successful mutations successful on presenter failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const paths = [{ path: 'a.md' }]
    ctx.tools.register(defineTool({
      name: 'write', description: 'mutation', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'done',
      presentCall: () => ({ card: 'generic', title: 'write', kind: 'edit', locations: paths }),
    }))
    const off = ctx.on('tools/post-execute', () => Promise.resolve({ kind: 'accept' as const, value: 'replaced' }))
    const result = await ctx.tools.execute({ callId: CallId('captured'), name: 'write', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('mutation failed')
    expect(result.producedFiles).toEqual(['a.md'])
    expect(Object.isFrozen(result.producedFiles)).toBe(true)
    paths[0]!.path = 'later.md'
    expect(result.producedFiles).toEqual(['a.md'])
    off()
    ctx.tools.register(defineTool({
      name: 'bad-presenter', description: 'successful mutation', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'done',
      presentCall: () => { throw new Error('optional presenter unavailable') },
    }))
    const unindexed = await ctx.tools.execute({ callId: CallId('unindexed'), name: 'bad-presenter', arguments: {}, signal: new AbortController().signal })
    expect(unindexed.isError).toBe(false)
    expect(unindexed).not.toHaveProperty('producedFiles')
    await ctx.fiber.dispose()
  })
})
