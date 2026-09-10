import { describe, expect, it, vi } from 'vitest'
import { ConnectionReadiness } from '../src/client/readiness.ts'

describe('connection readiness publication', () => {
  it('retains snapshot identity until a phase or handshake changes', () => {
    const source = new ConnectionReadiness()
    const first = source.getSnapshot()
    const listener = vi.fn()
    const off = source.subscribe(listener)
    source.publish('stopped')
    expect(source.getSnapshot()).toBe(first)
    expect(listener).not.toHaveBeenCalled()
    source.publish('connecting')
    expect(source.getSnapshot()).toEqual({ phase: 'connecting', epoch: 0 })
    source.publish('synchronizing', true)
    source.publish('ready')
    expect(source.getSnapshot()).toEqual({ phase: 'ready', epoch: 1 })
    source.publish('synchronizing', true)
    expect(source.getSnapshot()).toEqual({ phase: 'synchronizing', epoch: 2 })
    expect(listener).toHaveBeenCalledTimes(4)
    off()
    source.publish('error')
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('keeps other subscribers informed when one observer throws', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const source = new ConnectionReadiness()
      source.subscribe(() => { throw new Error('broken subscriber') })
      const listener = vi.fn()
      source.subscribe(listener)
      source.publish('connecting')
      expect(listener).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledOnce()
    } finally { log.mockRestore() }
  })
})
