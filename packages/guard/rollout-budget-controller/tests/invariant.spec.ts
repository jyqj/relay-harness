import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RolloutBudgetInvariant from '../src/invariant.ts'

describe('rollout-budget-controller invariant companion', () => {
  it('registers and removes the package installer with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(RolloutBudgetInvariant)
    await expect(ctx.plugin(RolloutBudgetInvariant).then(() => undefined)).rejects.toThrow(/already registered/)
    await fiber.dispose()
    await expect(ctx.plugin(RolloutBudgetInvariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
