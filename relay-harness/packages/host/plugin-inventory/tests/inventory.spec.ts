import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import { remoteMethods } from '@relay-harness/rlh-typert-protocol'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway', () => {
  it('publishes direct list and capabilities methods under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'capabilities', invocation: { kind: 'direct' } },
    ])
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = inventory.list()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect(inventory.list().entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
    })

    await ctx.loader.remove(pendingId)
    expect(inventory.list().entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('reports catalog capabilities with mounted-Loader evidence and no tool registry as unknown session', async () => {
    const { ctx, inventory } = await harness()
    ctx.loader.builtins['code-index-workspace-router'] = activePlugin
    // create()'s declared type omits `id`, but composed entries carry stable
    // ids from cordis.yml and the capability catalog matches on them; pass one.
    const withStableId = {
      id: 'code-index-workspace-router',
      name: 'cordis:code-index-workspace-router',
      config: { watcherEnabled: true },
    } as Parameters<typeof ctx.loader.create>[0]
    await ctx.loader.create(withStableId)
    const entry = inventory.capabilities().capabilities.find(
      capability => capability.capabilityId === 'code-index',
    )
    expect(entry).toBeDefined()
    expect(entry?.assembled.status).toBe('yes')
    expect(entry?.assembled.evidence).toContain('code-index-workspace-router')
    // The mounted config carries no embedding section: configured must not
    // leak into the folded state, and the capability stays installed.
    expect(entry?.configured.status).toBe('no')
    expect(entry?.configured.reason).toContain('embedding')
    expect(entry?.effective).toBe('installed')
    // The test harness mounts no tools service, so the session level is unknown.
    expect(entry?.sessionAvailable.status).toBe('unknown')
  })
})
