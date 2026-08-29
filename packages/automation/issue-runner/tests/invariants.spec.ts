import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import * as IssueRunnerInvariant from '../src/invariant.ts'

const PACKAGE_NAME = '@relay-harness/rlh-issue-runner'

describe('issue-runner invariant companion', () => {
  it('reserves the package name with no runtime checks, then releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const companion = await ctx.plugin(IssueRunnerInvariant)

    // The installer is empty: each provider owns publication, result, and
    // disposal settlement, so only the registration reservation is observable.
    expect(() => ctx.invariants.register(PACKAGE_NAME, () => {})).toThrow(/already registered/)
    await companion.dispose()
    expect(() => ctx.invariants.register(PACKAGE_NAME, () => {})).not.toThrow()
    await ctx.fiber.dispose()
  })
})
