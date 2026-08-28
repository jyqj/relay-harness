/** Stale invalidator: debounce collapse, flush semantics, clean teardown. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STALE_DEBOUNCE_MS, StaleInvalidator, toolResultStaleHandler } from '../src/invalidate.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('StaleInvalidator', () => {
  it('collapses a burst of schedules into one deferred trigger', async () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const invalidator = new StaleInvalidator(DEFAULT_STALE_DEBOUNCE_MS, trigger)
    expect(invalidator.pending).toBe(false)
    invalidator.schedule()
    expect(invalidator.pending).toBe(true)
    vi.advanceTimersByTime(400)
    invalidator.schedule()
    vi.advanceTimersByTime(499)
    expect(trigger).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(trigger).toHaveBeenCalledOnce()
    expect(invalidator.pending).toBe(false)
  })

  it('flushes immediately past any outstanding timer', () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const invalidator = new StaleInvalidator(60_000, trigger)
    invalidator.schedule()
    invalidator.flushNow()
    expect(trigger).toHaveBeenCalledOnce()
    expect(invalidator.pending).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(trigger).toHaveBeenCalledOnce()
  })

  it('dispose cancels the outstanding timer without firing', async () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const invalidator = new StaleInvalidator(10, trigger)
    invalidator.schedule()
    invalidator.dispose()
    invalidator.dispose()
    await vi.advanceTimersByTimeAsync(50)
    expect(trigger).not.toHaveBeenCalled()
    expect(invalidator.pending).toBe(false)
  })
})

describe('toolResultStaleHandler', () => {
  it('schedules only for tool/result events', () => {
    vi.useFakeTimers()
    const invalidator = new StaleInvalidator(5, () => {})
    const scheduleSpy = vi.spyOn(invalidator, 'schedule')
    const handler = toolResultStaleHandler(invalidator)
    handler({ type: 'assistant/message' })
    handler({ type: 'session/started' })
    expect(scheduleSpy).not.toHaveBeenCalled()
    handler({ type: 'tool/result' })
    expect(scheduleSpy).toHaveBeenCalledOnce()
    invalidator.dispose()
  })
})
