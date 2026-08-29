/** Deterministic bounded-concurrency primitive used by scan/hash/parse stages. */

import { describe, expect, it } from 'vitest'
import { mapConcurrentOrdered } from '../src/parallel.ts'

describe('mapConcurrentOrdered', () => {
  it('bounds active work and preserves input order despite inverse completion order', async () => {
    let active = 0
    let maxActive = 0
    const output = await mapConcurrentOrdered([1, 2, 3, 4, 5, 6], 3, async (value) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, (7 - value) * 2))
      active--
      return `item-${value}`
    })
    expect(maxActive).toBe(3)
    expect(output).toEqual(['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6'])
  })

  it('refuses invalid concurrency', async () => {
    await expect(mapConcurrentOrdered([1], 0, async value => value)).rejects.toThrow(/positive safe integer/u)
  })
})
