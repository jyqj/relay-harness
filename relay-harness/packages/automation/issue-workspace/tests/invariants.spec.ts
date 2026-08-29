import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import * as IssueWorkspaceInvariant from '../src/invariant.ts'

describe('issue-workspace invariant companion', () => {
  it('installs with no runtime checks and re-mounts after disposal releases the reservation', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)

    // The installer is empty: the provider validates containment at each
    // filesystem mutation, so companion lifetime is the observable surface.
    const first = await ctx.plugin(IssueWorkspaceInvariant)
    await expect(ctx.plugin(IssueWorkspaceInvariant)).rejects.toThrow(/already registered/)
    await first.dispose()

    const second = await ctx.plugin(IssueWorkspaceInvariant)
    await second.dispose()
    await ctx.fiber.dispose()
  })
})
