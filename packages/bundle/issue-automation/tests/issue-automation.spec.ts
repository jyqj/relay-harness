import { describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { apply } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

describe('issue automation bundle marker', () => {
  it('stays behavior-free and reserves its invariant ownership', async () => {
    apply()
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(Invariant)
    await ctx.fiber.dispose()
  })
})
