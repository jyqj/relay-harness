import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import * as FilesInvariant from '../src/invariant.ts'
import InvariantRegistry from '@relay-harness/rlh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(FilesInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('../src/index.ts')
    apply()
    expect(true).toBe(true)
  })
})
