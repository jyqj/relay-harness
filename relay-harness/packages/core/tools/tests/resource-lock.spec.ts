import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolResourceIntent } from '@deepseek-ai/dsh-tools'
import { ToolResourceLockManager } from '../src/resource-lock.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !predicate(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('condition did not become true')
}

function call(ctx: Context, id: string, args: { id: string; key: string; access: 'read' | 'write' }, signal = new AbortController().signal) {
  return ctx.tools.execute({
    callId: CallId(id),
    name: 'locked',
    arguments: args,
    signal,
  })
}

describe('tool resource intents', () => {
  it('allows same-key readers to overlap', async () => {
    const ctx = await setup()
    const started: string[] = []
    const releases = new Map<string, () => void>()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'resource locked',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: args => [{ key: args.key, access: args.access }],
      async execute(args) {
        started.push(args.id)
        await new Promise<void>((resolve) => { releases.set(args.id, resolve) })
        return args.id
      },
    }))

    const first = call(ctx, 'c1', { id: 'r1', key: 'file:a', access: 'read' })
    const second = call(ctx, 'c2', { id: 'r2', key: 'file:a', access: 'read' })
    await until(() => started.length === 2)
    expect(started).toEqual(['r1', 'r2'])
    releases.get('r1')?.(); releases.get('r2')?.()
    await Promise.all([first, second])
  })

  it('serializes conflicts while a different key continues', async () => {
    const ctx = await setup()
    const started: string[] = []
    const releases = new Map<string, () => void>()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'resource locked',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: args => [{ key: args.key, access: args.access }],
      async execute(args) {
        started.push(args.id)
        await new Promise<void>((resolve) => { releases.set(args.id, resolve) })
        return args.id
      },
    }))

    const first = call(ctx, 'c1', { id: 'w1', key: 'file:a', access: 'write' })
    const blocked = call(ctx, 'c2', { id: 'r2', key: 'file:a', access: 'read' })
    const independent = call(ctx, 'c3', { id: 'w3', key: 'file:b', access: 'write' })
    await until(() => started.includes('w1') && started.includes('w3'))
    expect(started).not.toContain('r2')
    releases.get('w1')?.()
    await until(() => started.includes('r2'))
    releases.get('r2')?.(); releases.get('w3')?.()
    await Promise.all([first, blocked, independent])
  })

  it('does not let a later reader bypass a queued writer', async () => {
    const ctx = await setup()
    const started: string[] = []
    const releases = new Map<string, () => void>()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'resource locked',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: args => [{ key: args.key, access: args.access }],
      async execute(args) {
        started.push(args.id)
        await new Promise<void>((resolve) => { releases.set(args.id, resolve) })
        return args.id
      },
    }))

    const reader = call(ctx, 'c1', { id: 'r1', key: 'file:a', access: 'read' })
    await until(() => started.includes('r1'))
    const writer = call(ctx, 'c2', { id: 'w2', key: 'file:a', access: 'write' })
    const laterReader = call(ctx, 'c3', { id: 'r3', key: 'file:a', access: 'read' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(started).toEqual(['r1'])
    releases.get('r1')?.()
    await until(() => started.includes('w2'))
    expect(started).not.toContain('r3')
    releases.get('w2')?.()
    await until(() => started.includes('r3'))
    releases.get('r3')?.()
    await Promise.all([reader, writer, laterReader])
  })

  it('removes an aborted waiter without invoking its body', async () => {
    const ctx = await setup()
    const started: string[] = []
    const release = Promise.withResolvers<undefined>()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'resource locked',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: args => [{ key: args.key, access: args.access }],
      async execute(args) {
        started.push(args.id)
        if (args.id === 'holder') await release.promise
        return args.id
      },
    }))
    const holder = call(ctx, 'c1', { id: 'holder', key: 'file:a', access: 'write' })
    await until(() => started.includes('holder'))
    const controller = new AbortController()
    const waiting = call(ctx, 'c2', { id: 'waiting', key: 'file:a', access: 'write' }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(new Error('cancel waiter'))
    const result = await waiting

    expect(started).toEqual(['holder'])
    expect(result.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
    release.resolve(undefined)
    await holder
  })

  it.each([
    [[{ key: '', access: 'read' }], 'key must be a non-empty string'],
    [[{ key: 'file:a', access: 'invalid' }], 'invalid access'],
  ] as const)('contains invalid resource claims as tool errors', async (intents, message) => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'invalid resource lock',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: () => intents as unknown as ToolResourceIntent[],
      async execute() { return 'unexpected' },
    }))

    const result = await call(ctx, 'c1', { id: 'bad', key: 'file:a', access: 'read' })
    expect(result.error?.message).toContain(message)
  })

  it('contains a non-array resource resolver result before the tool body', async () => {
    const ctx = await setup()
    let invoked = false
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'invalid resolver result',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: () => null as never,
      async execute() { invoked = true; return 'unexpected' },
    }))

    const result = await call(ctx, 'c1', { id: 'bad', key: 'file:a', access: 'read' })
    expect(result.error?.message).toContain('resourceIntents must return an array')
    expect(invoked).toBe(false)
  })

  it('maps cancellation while a resource resolver rejects to pre-dispatch abort', async () => {
    const ctx = await setup()
    const entered = Promise.withResolvers<undefined>()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'cancellable resolver',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: (_args, exec) => new Promise((_resolve, reject) => {
        entered.resolve(undefined)
        exec.signal.addEventListener('abort', () => { reject(new Error('resolver aborted')) }, { once: true })
      }),
      async execute() { return 'unexpected' },
    }))
    const controller = new AbortController()
    const pending = call(ctx, 'c1', { id: 'cancel', key: 'file:a', access: 'write' }, controller.signal)
    await entered.promise
    controller.abort(new Error('cancel resource resolver'))

    const result = await pending
    expect(result.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
  })

  it('rechecks cancellation after a signal-ignoring resource resolver settles', async () => {
    const ctx = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.tools.register(defineTool({
      name: 'locked',
      description: 'late resolver',
      parameters: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        access: { type: 'string', required: true, enum: ['read', 'write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      resourceIntents: async (args) => {
        entered.resolve(undefined)
        await release.promise
        return [{ key: args.key, access: args.access }]
      },
      async execute() { return 'unexpected' },
    }))
    const controller = new AbortController()
    const pending = call(ctx, 'c1', { id: 'cancel', key: 'file:a', access: 'write' }, controller.signal)
    await entered.promise
    controller.abort(new Error('cancel late resolver'))
    release.resolve(undefined)

    const result = await pending
    expect(result.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
  })
})

describe('ToolResourceLockManager normalization and cleanup', () => {
  it('sorts multi-key claims and collapses duplicate reads under a write', async () => {
    const manager = new ToolResourceLockManager()
    const ran: string[] = []
    await manager.run([
      { key: 'b', access: 'read' },
      { key: 'a', access: 'read' },
      { key: 'a', access: 'write' },
      { key: 'c', access: 'read' },
      { key: 'c', access: 'read' },
    ], new AbortController().signal, async () => { ran.push('action') })
    expect(ran).toEqual(['action'])
  })

  it('rejects a pre-aborted acquisition with a stable Error and releases after action failure', async () => {
    const manager = new ToolResourceLockManager()
    const controller = new AbortController()
    controller.abort('stop')
    await expect(manager.run(
      [{ key: 'a', access: 'write' }],
      controller.signal,
      async () => undefined,
    )).rejects.toThrow('tool resource acquisition aborted: stop')

    await expect(manager.run(
      [{ key: 'a', access: 'write' }],
      new AbortController().signal,
      async () => { throw new Error('action failed') },
    )).rejects.toThrow('action failed')
    await expect(manager.run(
      [{ key: 'a', access: 'write' }],
      new AbortController().signal,
      async () => 'recovered',
    )).resolves.toBe('recovered')
  })
})
