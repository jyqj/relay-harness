import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import ProductModeService from '../src/index.ts'

describe('ProductModeService', () => {
  it('defaults fresh installs to simple and persists explicit developer/simple choices', async () => {
    const ctx = new Context()
    let value = { mode: 'simple' as 'simple' | 'developer' }
    const update = vi.fn(async (patch: object) => { value = { ...value, ...patch } })
    ctx.provide('settings', { register: () => ({ get: () => value, update, replace: vi.fn(), watch: vi.fn() }) } as never)
    await ctx.plugin(ProductModeService)
    expect(ctx.productMode.get()).toEqual({ mode: 'simple' })
    await expect(ctx.productMode.set({ mode: 'developer' })).resolves.toEqual({ mode: 'developer' })
    expect(update).toHaveBeenCalledWith({ mode: 'developer' })
    await expect(ctx.productMode.set({ mode: 'simple' })).resolves.toEqual({ mode: 'simple' })
  })
})
