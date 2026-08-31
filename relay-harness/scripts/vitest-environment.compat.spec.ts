// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

describe('Vitest jsdom compatibility', () => {
  it('provides isolated browser storage instead of Node process storage', () => {
    if (process.allowedNodeEnvironmentFlags.has('--webstorage')) {
      expect(process.execArgv.filter(argument => argument === '--no-webstorage')).toHaveLength(1)
    }
    localStorage.setItem('rlh-vitest-storage-probe', 'available')

    expect(localStorage.getItem('rlh-vitest-storage-probe')).toBe('available')
    localStorage.removeItem('rlh-vitest-storage-probe')
  })

  it('models the unavailable jsdom canvas capability without virtual-console noise', () => {
    expect(document.createElement('canvas').getContext('2d')).toBeNull()
  })
})
