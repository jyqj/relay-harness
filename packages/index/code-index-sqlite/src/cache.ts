/**
 * LRU cache over decoded chunk text.
 *
 * Mirrors the reference implementation's discipline (decompression caches
 * keyed on the index clock, fed only by rows that actually decoded): slots key
 * on `(index_epoch, chunk_rowid)`, so the natural per-transaction bump
 * invalidates every stale entry without a manual sweep, and degraded read
 * results never enter because the write side accepts only a freshness pair —
 * a caller whose channel degraded passes none and stores nothing.
 *
 * @module @relay-harness/rlh-code-index-sqlite/cache
 */

import type { EpochPair, RepoSizeTier } from '@relay-harness/rlh-code-index'

/**
 * Entry capacity per repository-size tier. Package-local decision: the store
 * decodes whole chunk texts for grep scans, so headroom scales with the tier's
 * working set rather than with any seam constant. Recorded in this package's
 * README (`Storage Layout`) as the owning table for that choice.
 */
const CHUNK_TEXT_CACHE_CAPACITY: Record<RepoSizeTier, number> = {
  tiny: 128,
  small: 256,
  medium: 384,
  large: 512,
}

/**
 * Resolve the decoded-text entry budget for a tier.
 * @param tier - repository-size class derived upstream from `countFiles()`.
 * @returns maximum cached entries: 128 / 256 / 384 / 512 per tier step.
 */
export function chunkTextCacheCapacityForTier(tier: RepoSizeTier): number {
  return CHUNK_TEXT_CACHE_CAPACITY[tier]
}

/**
 * Build one cache key out of an epoch counter and a base-table rowid. The
 * epoch is part of the key, not of a stored tag, so entries written under an
 * older clock become unreachable the moment any commit lands.
 * @param epoch - the index epoch the entry was decoded under.
 * @param rowid - the `chunks.rowid` the text was decoded from.
 * @returns the composite `${epoch}#${rowid}` key string.
 */
export function chunkCacheKey(epoch: number, rowid: number): string {
  return `${epoch}#${rowid}`
}

/** Cumulative hit/miss counters and occupancy, for status tooling to display. */
export interface ChunkTextCacheStats {
  /** Reads served from a live slot. */
  readonly hits: number
  /** Reads that missed; includes reads against a superseded epoch's keys. */
  readonly misses: number
  /** Entries evicted oldest-first after the capacity was reached. */
  readonly evictions: number
  /** Entries currently resident. */
  readonly size: number
  /** Configured maximum ({@link chunkTextCacheCapacityForTier}). */
  readonly capacity: number
}

/** Insertion-style LRU over decoded chunk texts with hit/miss accounting. */
export class ChunkTextCache {
  private readonly entries = new Map<string, string>()
  private hits = 0
  private misses = 0
  private evictions = 0

  /**
   * @param capacity - maximum resident entries; the tier table above is the
   *   intended source for this value.
   */
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`ChunkTextCache capacity must be a positive integer, got ${capacity}`)
    }
  }

  /**
   * Read one entry, refreshing its recency.
   * @param key - composite key from {@link chunkCacheKey}.
   * @returns the cached text, or `undefined` on a miss (including any key
   *   minted under a since-superseded epoch).
   */
  get(key: string): string | undefined {
    const value = this.entries.get(key)
    if (value === undefined) {
      this.misses++
      return undefined
    }
    this.hits++
    // Map iteration order is insertion order: delete + re-set demotes the
    // entry to most-recently-used, which is what the eviction pass checks.
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /**
   * Store one decoded text under an explicit freshness pair. The channel that
   * produced `value` must have completed without degradation (`readErrors`
   * empty); callers holding no trustworthy pair omit it and the call becomes a
   * counted no-op — degraded results can therefore never enter the cache.
   * @param key - composite key from {@link chunkCacheKey}.
   * @param value - decoded text to cache.
   * @param freshEpochs - the epoch pair observed while decoding, or omitted
   *   when the producing path degraded.
   * @returns true when the entry was stored.
   */
  setIfFresh(key: string, value: string, freshEpochs?: EpochPair): boolean {
    if (freshEpochs === undefined) return false
    return this.store(key, value)
  }

  /**
   * Commit one entry LRU-first, evicting the oldest resident when at capacity.
   * Split out as the single hook tests observe when asserting that a rejected
   * {@link setIfFresh} wrote nothing.
   */
  protected store(key: string, value: string): boolean {
    if (this.entries.size >= this.capacity && !this.entries.has(key)) {
      // A resident entry always exists here: capacity >= 1 held at construction.
      this.entries.delete(this.entries.keys().next().value as string)
      this.evictions++
    }
    this.entries.delete(key)
    this.entries.set(key, value)
    return true
  }

  /**
   * Snapshot the cumulative counters and current occupancy.
   * @returns hits, misses, evictions, resident size, and capacity.
   */
  stats(): ChunkTextCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
      capacity: this.capacity,
    }
  }
}
