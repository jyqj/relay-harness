import { describe, expect, it } from 'vitest'
import { getStaticModules, PLATFORM_MODULES } from '../src/index.ts'

describe('browser platform module table', () => {
  it('seeds every declared singleton, including generated Remote schema codecs', () => {
    const modules = getStaticModules()
    expect(Object.keys(modules).sort()).toEqual([...PLATFORM_MODULES].sort())
    expect(modules['zod']).toHaveProperty('z')
  })
})
