import { describe, expect, it } from 'vitest'
import { workAvailability } from '../src/client/work-availability.ts'

const open = { openState: 'open' as const, removed: false }

describe('work availability from connection and history', () => {
  it.each([
    ['stopped', 'disconnected'], ['reconnecting', 'disconnected'],
    ['connecting', 'synchronizing'], ['synchronizing', 'synchronizing'],
    ['error', 'error'], ['ready', 'ready'],
  ] as const)('does not confuse %s with a ready history window', (phase, expected) => {
    expect(workAvailability({ phase, epoch: 1 }, open)).toBe(expected)
  })

  it.each([
    [undefined, 'loading'],
    [{ openState: 'cold', removed: false }, 'loading'],
    [{ openState: 'loading', removed: false }, 'loading'],
    [{ openState: 'error', removed: false }, 'error'],
    [{ openState: 'open', removed: true }, 'removed'],
  ] as const)('requires an open, non-removed window (%j)', (snapshot, expected) => {
    expect(workAvailability({ phase: 'ready', epoch: 2 }, snapshot)).toBe(expected)
  })
})
