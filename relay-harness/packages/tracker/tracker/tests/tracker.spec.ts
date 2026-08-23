import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import type { JsonValue } from '@relay-harness/rlh-session'
import TrackerRegistry, {
  TrackerIssueId,
  type TrackerIssue,
  type TrackerProvider,
  type TrackerToolBinding,
} from '../src/index.ts'

const issue: TrackerIssue = {
  id: TrackerIssueId('issue-1'),
  identifier: 'ENG-1',
  title: 'Implement tracker seam',
  state: 'Todo',
  labels: ['agent'],
  blockedBy: [],
  dispatchable: true,
}

function provider(overrides: Partial<TrackerToolBinding> = {}): TrackerProvider {
  return {
    name: 'memory',
    fetchIssuesByStates: () => Promise.resolve([issue]),
    fetchIssuesByIds: () => Promise.resolve([issue]),
    bindTools: () => ({
      provider: 'memory',
      tools: [{
        name: 'tracker_echo',
        description: 'Echo one tracker value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
      secretEnvironmentNames: ['TRACKER_TOKEN'],
      execute: (_name: string, arguments_: JsonValue) => Promise.resolve({ success: true, value: arguments_ }),
      ...overrides,
    }),
  }
}

async function boot() {
  const ctx = new Context()
  const fiber = ctx.plugin(TrackerRegistry)
  await fiber
  return { ctx, fiber }
}

describe('TrackerRegistry', () => {
  it('registers providers through an effect and preserves returned bindings after removal', async () => {
    const { ctx, fiber } = await boot()
    const install = Object.assign(
      (child: Context) => { child.trackers.register(provider()) },
      { inject: ['trackers'] },
    )
    const owner = ctx.plugin(install)
    await owner
    expect(ctx.trackers.list()).toEqual(['memory'])

    const binding = ctx.trackers.bindTools('memory')
    await owner.dispose()
    expect(ctx.trackers.list()).toEqual([])
    await expect(binding.execute('tracker_echo', { value: 'ok' }, { issue }))
      .resolves.toEqual({ success: true, value: { value: 'ok' } })
    await fiber.dispose()
  })

  it('returns a structured failure for an unadvertised tool without reaching the provider', async () => {
    const { ctx, fiber } = await boot()
    let executions = 0
    ctx.trackers.register(provider({
      execute: () => {
        executions += 1
        return Promise.resolve({ success: true, value: null })
      },
    }))
    const binding = ctx.trackers.bindTools('memory')
    await expect(binding.execute('unknown', {}, { issue })).resolves.toMatchObject({
      success: false,
      value: { error: { code: 'UNSUPPORTED_TRACKER_TOOL', tool: 'unknown' } },
    })
    expect(executions).toBe(0)
    await fiber.dispose()
  })

  it('rejects duplicate providers and malformed captured boundaries', async () => {
    const { ctx, fiber } = await boot()
    ctx.trackers.register(provider())
    expect(() => ctx.trackers.register(provider())).toThrow(/already registered/)
    expect(() => ctx.trackers.bindTools('memory')).not.toThrow()

    const otherCtx = new Context()
    const otherFiber = otherCtx.plugin(TrackerRegistry)
    await otherFiber
    otherCtx.trackers.register(provider({ secretEnvironmentNames: ['BAD=NAME'] }))
    expect(() => otherCtx.trackers.bindTools('memory')).toThrow(/environment name/)
    await otherFiber.dispose()
    await fiber.dispose()
  })

  it('fails loud for invalid names, missing providers, and divergent bindings', async () => {
    const { ctx, fiber } = await boot()
    expect(() => ctx.trackers.register({ ...provider(), name: 'Bad Name' })).toThrow(/must match/)
    expect(() => ctx.trackers.require('missing')).toThrow(/not registered/)
    ctx.trackers.register(provider({ provider: 'other' }))
    expect(() => ctx.trackers.bindTools('memory')).toThrow(/binding for/)
    await fiber.dispose()
  })

  it.each([
    {
      label: 'invalid tool name',
      binding: { tools: [{ name: 'bad name', description: 'Valid.', parameters: { type: 'object' } }] },
      error: /tool name/,
    },
    {
      label: 'duplicate tool',
      binding: { tools: [
        { name: 'same', description: 'First.', parameters: { type: 'object' } },
        { name: 'same', description: 'Second.', parameters: { type: 'object' } },
      ] },
      error: /repeats tool/,
    },
    {
      label: 'blank description',
      binding: { tools: [{ name: 'valid', description: ' ', parameters: { type: 'object' } }] },
      error: /description/,
    },
    {
      label: 'duplicate environment alias',
      binding: { secretEnvironmentNames: ['TOKEN', 'TOKEN'] },
      error: /repeats secret/,
    },
  ])('rejects $label', async ({ binding, error }) => {
    const { ctx, fiber } = await boot()
    ctx.trackers.register(provider(binding))
    expect(() => ctx.trackers.bindTools('memory')).toThrow(error)
    await fiber.dispose()
  })
})
