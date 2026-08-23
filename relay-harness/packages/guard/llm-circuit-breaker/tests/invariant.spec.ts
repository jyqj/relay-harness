import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import * as Invariant from '../src/invariant.ts'

describe('llm-circuit-breaker invariant', () => {
  it('registers with the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(Invariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
