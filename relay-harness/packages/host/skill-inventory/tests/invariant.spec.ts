import { Context } from '@relay-harness/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import * as SkillInventoryInvariant from '../src/invariant.ts'

describe('host-skill-inventory invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SkillInventoryInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
