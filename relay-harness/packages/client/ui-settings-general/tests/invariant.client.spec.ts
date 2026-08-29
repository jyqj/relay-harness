import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import * as GeneralInvariant from '@relay-harness/rlh-client-ui-settings-general/invariant'
import InvariantRegistry from '@relay-harness/rlh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(GeneralInvariant).await()).resolves.toBeDefined()
  })
})
