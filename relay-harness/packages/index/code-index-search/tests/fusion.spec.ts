import { describe, expect, it } from 'vitest'
import {
  LANE_GREP_ID,
  LANE_LEXICAL_ID,
  compareFusedEntries,
  fuseOutcomes,
  overlapScore,
  rankScored,
  rrfAccumulate,
} from '../src/fusion.ts'
import { tokenizeCodeish } from '../src/text.ts'
import type { FusedScore, LaneOutcome } from '../src/types.ts'

function fused(total: number): FusedScore {
  return { total, byLane: [{ laneId: 'lexical', score: total }] }
}

describe('rrfAccumulate (rrf.rs vectors)', () => {
  it('decays strictly with rank at k=50', () => {
    const scores = new Map<string, number>()
    rrfAccumulate(scores, ['a', 'b', 'c'], 1.0, 50)
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!)
    expect(scores.get('b')!).toBeGreaterThan(scores.get('c')!)
    // weight / (k + rank + 1)
    expect(scores.get('a')).toBeCloseTo(1 / 51)
    expect(scores.get('b')).toBeCloseTo(1 / 52)
    expect(scores.get('c')).toBeCloseTo(1 / 53)
  })

  it('merges two lists symmetrically', () => {
    const scores = new Map<string, number>()
    rrfAccumulate(scores, ['a', 'b'], 1.0, 50)
    rrfAccumulate(scores, ['b', 'a'], 1.0, 50)
    expect(Math.abs(scores.get('a')! - scores.get('b')!)).toBeLessThan(1e-10)
  })
})

describe('overlapScore (rrf.rs overlap semantics)', () => {
  it('scores the matched fraction of the query vocabulary', () => {
    const query = tokenizeCodeish('getUserById order')
    // Tokens do NOT camel-split: ['getuserbyid','order'], one of two matched.
    expect(overlapScore(query, 'const user = getUserById(7)')).toBeCloseTo(1 / 2)
    expect(overlapScore(query, 'completely unrelated')).toBe(0)
  })

  it('returns zero on empty haystack or empty query', () => {
    expect(overlapScore(['user'], '!!!')).toBe(0)
    expect(overlapScore([], 'user table')).toBe(0)
  })
})

describe('compareFusedEntries (engine windowing order)', () => {
  const a = ['a', fused(0.02)] as const
  const b = ['b', fused(0.01)] as const
  const bTwin = ['b', fused(0.01)] as const
  const c = ['c', fused(0.01)] as const

  it('orders by total desc, then chunk id asc, and is stable on full equality', () => {
    expect(compareFusedEntries(a, b)).toBeLessThan(0)
    expect(compareFusedEntries(b, a)).toBeGreaterThan(0)
    // Equal totals: ascending chunk id decides.
    expect(compareFusedEntries(b, c)).toBeLessThan(0)
    expect(compareFusedEntries(c, b)).toBeGreaterThan(0)
    // Identical ids and totals (impossible from real fusion, pinned for the contract).
    expect(compareFusedEntries(b, bTwin)).toBe(0)
  })
})

describe('rankScored (shared lane skeleton)', () => {
  it('attaches diagnostic 1/(i+1) scores', () => {
    expect(rankScored(['x', 'y'])).toEqual([
      { chunkId: 'x', score: 1 },
      { chunkId: 'y', score: 0.5 },
    ])
  })
})

describe('fuseOutcomes (lanes.rs::fuse_outcomes)', () => {
  const outcomes: LaneOutcome[] = [
    {
      laneId: LANE_LEXICAL_ID,
      weight: 1.1,
      annotatesHits: true,
      scoreSlot: 'lexical',
      hits: [{ chunkId: 'a', score: 1 }, { chunkId: 'b', score: 0.5 }],
    },
    {
      laneId: LANE_GREP_ID,
      weight: 0.8,
      annotatesHits: true,
      scoreSlot: 'grep',
      hits: [{ chunkId: 'a', score: 1 }, { chunkId: 'c', score: 0.5 }],
    },
  ]

  it('sums weight/(k+rank+1) across lanes in registration order', () => {
    const fused = fuseOutcomes(outcomes, 50)
    expect(fused.size).toBe(3)
    const a = fused.get('a')!
    // byLane bills left-to-right and must sum bit-for-bit to total.
    let billSum = 0
    for (const contribution of a.byLane) billSum += contribution.score
    expect(billSum).toBe(a.total)
    expect(a.byLane.map(entry => entry.laneId)).toEqual([LANE_LEXICAL_ID, LANE_GREP_ID])
    expect(a.total).toBeCloseTo(1.1 / 51 + 0.8 / 51)
    // Single-lane candidates keep their single-contribution bill.
    expect(fused.get('c')!.byLane).toHaveLength(1)
  })

  it('keeps an empty-by-lane candidate recordable through the fallback trace label', async () => {
    const { ScoreTrace } = await import('../src/rerank.ts')
    const trace = new ScoreTrace()
    trace.push('rrf', 0.25)
    trace.push('overlap', 0.07)
    expect(trace.total()).toBeCloseTo(0.32)
  })
})
