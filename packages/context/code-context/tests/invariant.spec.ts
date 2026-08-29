import { Context } from '@relay-harness/cordis'
import { describe, expect, it } from 'vitest'
import InvariantService from '@relay-harness/rlh-invariants'
import * as CodeContextInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers the package ownership under its package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(CodeContextInvariant).await()).resolves.toBeDefined()
  })
})
