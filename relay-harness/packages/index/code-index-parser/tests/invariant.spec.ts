import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry from '@relay-harness/rlh-invariants'

describe('code-index-parser invariant companion', () => {
  it('registers its package with the runtime diagnostics registry and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const mod = await import('../src/invariant.ts')
    expect(mod.name).toBe('code-index-parser-invariant')
    expect(mod.inject).toEqual(['invariants'])
    const disposer = await mod.apply(ctx)
    expect(typeof disposer).toBe('function')
    disposer()
  })
})
