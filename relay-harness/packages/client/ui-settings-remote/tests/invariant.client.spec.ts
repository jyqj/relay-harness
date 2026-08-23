import { Context } from '@relay-harness/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import * as RemoteInvariant from '../src/invariant.ts'

describe('ui-settings-remote invariant companion', () => {
  it('registers the empty installer and keeps the node half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(RemoteInvariant).await()).resolves.toBeDefined()
    const { apply } = await import('../src/index.ts')
    apply()
    await ctx.fiber.dispose()
  })
})
