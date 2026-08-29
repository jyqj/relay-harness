import { describe, expect, it, vi } from 'vitest'
import { ChunkTextCache, chunkCacheKey, chunkTextCacheCapacityForTier } from '../src/cache.ts'
import type { RepoSizeTier } from '@relay-harness/rlh-code-index'

const EPOCHS = { indexEpoch: 7, evidenceEpoch: 2, embeddingEpoch: 0 }

/** Test seam: re-declares the protected store hook public so it can be spied on. */
class ObservableCache extends ChunkTextCache {
  override store(key: string, value: string): boolean {
    return super.store(key, value)
  }
}

describe('ChunkTextCache', () => {
  it('maps each repository-size tier to its package-local capacity', () => {
    const tiers: readonly RepoSizeTier[] = ['tiny', 'small', 'medium', 'large']
    expect(tiers.map(chunkTextCacheCapacityForTier)).toEqual([128, 256, 384, 512])
  })

  it('rejects non-positive or fractional capacities at construction', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new ChunkTextCache(bad)).toThrow(RangeError)
      expect(() => new ChunkTextCache(bad)).toThrow(/positive integer/)
    }
    expect(new ChunkTextCache(4).stats()).toEqual({
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      capacity: 4,
    })
  })

  it('stores only fresh values; a degraded call site with no pair writes nothing', () => {
    const cache = new ObservableCache(4)
    const store = vi.spyOn(cache, 'store')
    const key = chunkCacheKey(EPOCHS.indexEpoch, 11)

    expect(cache.setIfFresh(key, 'decoded body', EPOCHS)).toBe(true)
    expect(store).toHaveBeenCalledTimes(1)
    expect(cache.get(key)).toBe('decoded body')

    // Degraded provenance (`readErrors` non-empty): omit the freshness pair.
    store.mockClear()
    expect(cache.setIfFresh(key, 'degraded decode')).toBe(false)
    expect(store).not.toHaveBeenCalled()
    expect(cache.stats().size).toBe(1)
  })

  it('invalidates every entry when the epoch counter advances because keys embed it', () => {
    const cache = new ChunkTextCache(4)
    const oldKey = chunkCacheKey(1, 42)
    cache.setIfFresh(oldKey, 'stale text', { indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })
    expect(cache.get(oldKey)).toBe('stale text')

    // One commit later, both the key space and the lookups move forward.
    const newKey = chunkCacheKey(2, 42)
    expect(newKey).not.toBe(oldKey)
    expect(cache.get(newKey)).toBeUndefined()
    expect(cache.setIfFresh(newKey, 'fresh text', { indexEpoch: 2, evidenceEpoch: 0, embeddingEpoch: 0 })).toBe(true)
    expect(cache.get(newKey)).toBe('fresh text')
    expect(cache.get(oldKey)).toBe('stale text')
  })

  it('evicts least-recently-used entries once the capacity is reached', () => {
    const cache = new ChunkTextCache(2)
    cache.setIfFresh('a', 'text-a', EPOCHS)
    cache.setIfFresh('b', 'text-b', EPOCHS)
    expect(cache.get('a')).toBe('text-a') // refresh recency of `a`
    cache.setIfFresh('c', 'text-c', EPOCHS) // evicts `b`

    expect(cache.stats()).toMatchObject({ size: 2, evictions: 1 })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('text-a')
    expect(cache.get('c')).toBe('text-c')
  })

  it('counts hits and misses cumulatively across superseded keys', () => {
    const cache = new ChunkTextCache(4)
    expect(cache.get('absent')).toBeUndefined()
    cache.setIfFresh(chunkCacheKey(3, 5), 'body', { indexEpoch: 3, evidenceEpoch: 0, embeddingEpoch: 0 })
    void cache.get(chunkCacheKey(3, 5))
    expect(cache.get(chunkCacheKey(9, 5))).toBeUndefined() // post-bump lookup misses
    const stats = cache.stats()
    expect(stats).toEqual({ hits: 1, misses: 2, evictions: 0, size: 1, capacity: 4 })
  })

  it('re-stores over an existing key without evicting anything else', () => {
    const cache = new ChunkTextCache(1)
    cache.setIfFresh('only', 'first', EPOCHS)
    cache.setIfFresh('only', 'second', EPOCHS)
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, evictions: 0, size: 1, capacity: 1 })
    expect(cache.get('only')).toBe('second')
  })
})
