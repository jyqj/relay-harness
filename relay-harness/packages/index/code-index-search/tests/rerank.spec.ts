import { describe, expect, it } from 'vitest'
import { DEFAULT_FEATURE_GATES, DEFAULT_RANKING_CONFIG } from '../src/config.ts'
import { LaneRanks } from '../src/plan.ts'
import { dedupeReasons, isProjectDoc, rerankCandidate, ScoreTrace } from '../src/rerank.ts'
import type { LaneOutcome } from '../src/types.ts'

const ranking = DEFAULT_RANKING_CONFIG

// Fixture paths are assembled from segments so the doc-reference scanner does not read them
// as repository links; isProjectDoc lowercases before matching, so the casing stays faithful
// to the heuristic under test.
const guidePath = ['docs', 'getting-started.md'].join('/')

function outcome(chunkIds: readonly string[], weight: number): LaneOutcome {
  return {
    laneId: 'lexical',
    weight,
    annotatesHits: true,
    scoreSlot: 'lexical',
    hits: chunkIds.map((chunkId, position) => ({ chunkId, score: 1 / (position + 1) })),
  }
}

function ranksFor(chunkIds: readonly string[]): LaneRanks {
  return LaneRanks.fromOutcomes([outcome(chunkIds, 1.1)])
}

function baseInput(over: Partial<Parameters<typeof rerankCandidate>[0]> = {}): Parameters<typeof rerankCandidate>[0] {
  const fusedByLane = over.fused ?? { total: 1.1 / 51, byLane: [{ laneId: 'lexical', score: 1.1 / 51 }] }
  return {
    chunkId: 'c1',
    filePath: 'src/a.ts',
    breadcrumb: '',
    symbolName: null,
    text: 'user table storage',
    fused: fusedByLane,
    queryTokens: ['user', 'missingtoken'],
    laneRanks: ranksFor(['c1']),
    ranking,
    gates: DEFAULT_FEATURE_GATES,
    filtersPathPrefix: null,
    boostFiles: new Set(),
    recentFiles: new Set(),
    pinnedFiles: new Set(),
    overlayFiles: new Set(),
    preselectResult: {
      files: [],
      scores: new Map(),
      reasons: new Map(),
      laneStats: { ftsHits: 0, tokenHits: 0, usedFallback: false },
      layerScores: new Map(),
    },
    ...over,
  }
}

describe('ScoreTrace', () => {
  it('totals components left-to-right', () => {
    const trace = new ScoreTrace()
    trace.push('rrf:lexical', 1.1 / 51)
    trace.push('overlap', 0.175)
    expect(trace.total()).toBeCloseTo(1.1 / 51 + 0.175, 15)
  })
})

describe('rerankCandidate addition table', () => {
  it('adds rrf lanes, overlap, doc-file and boosts in historical order', () => {
    const outcomes = [outcome(['c1'], 1.1)]
    const input = baseInput({
      filePath: guidePath,
      breadcrumb: '# guide',
      queryTokens: ['user'],
      boostFiles: new Set([guidePath]),
      recentFiles: new Set([guidePath]),
      pinnedFiles: new Set([guidePath]),
      overlayFiles: new Set([guidePath]),
      preselectResult: {
        files: [guidePath],
        scores: new Map([[guidePath, 7.5]]),
        reasons: new Map([[guidePath, ['fts-summary', 'symbol:user', 'path-token:user', 'fourth-ignored']]]),
        laneStats: { ftsHits: 1, tokenHits: 2, usedFallback: false },
        layerScores: new Map([[guidePath, [['fts-summary', 5.5], ['token-search', 2.0]]]]),
      },
    })
    // lane annotation comes from the ranks built out of outcomes, in collection order.
    const { rerankScore, reasons } = rerankCandidate({ ...input, laneRanks: LaneRanks.fromOutcomes(outcomes) })

    // Manual replay of the traced bill:
    let expected = 1.1 / 51 // rrf:lexical
    expected += 1 * ranking.overlapWeight // overlap ('user' matched, one-token query)
    expected += ranking.docFileBonus
    expected += ranking.workingSetBoost + ranking.recentFileBoost + ranking.pinnedContextBoost + ranking.overlayNeighborBoost
    expected += Math.min(7.5 * ranking.stageAWeight, ranking.stageACap) // min(0.3, 0.25)
    expect(rerankScore).toBeCloseTo(expected, 14)

    expect(reasons).toEqual([
      'lexical@1',
      'doc-file',
      'working-set-boost',
      'recent-file',
      'pinned-context',
      'overlay-neighbor',
      // Only the first three file reasons surface…
      'fts-summary',
      'symbol:user',
      'path-token:user',
      // …then the unbounded per-layer bill, two decimals each.
      'preselect:fts-summary:+5.50',
      'preselect:token-search:+2.00',
    ])
  })

  it('adds the path-prefix trace component without emitting a reason', () => {
    const { rerankScore } = rerankCandidate(baseInput({ filtersPathPrefix: 'src/', filePath: 'src/prefixed/deep.ts' }))
    let expected = 0
    expected += 1.1 / 51
    expected += 0.5 * ranking.overlapWeight
    expected += ranking.pathPrefixBonus
    expect(rerankScore).toBeCloseTo(expected, 14)
  })

  it('never adds symbol-exact while the gate is explicitly closed even for matching names', () => {
    const { rerankScore, reasons } = rerankCandidate(
      baseInput({ symbolName: 'User', gates: { ...DEFAULT_FEATURE_GATES, symbolExactEnabled: false } }),
    )
    expect(reasons).not.toContain('symbol-exact')
    let expected = 1.1 / 51
    expected += 0.5 * ranking.overlapWeight
    expect(rerankScore).toBeCloseTo(expected, 14)
  })

  it('adds symbol-exact under the default gates now that detail rows carry names', () => {
    const { rerankScore, reasons } = rerankCandidate(baseInput({ symbolName: 'User' }))
    expect(reasons).toContain('symbol-exact')
    let expected = 1.1 / 51
    expected += 0.5 * ranking.overlapWeight
    expected += ranking.symbolExactBonus
    expect(rerankScore).toBeCloseTo(expected, 14)
  })

  it('bills an unattributed fused total under the plain rrf label', () => {
    const { rerankScore } = rerankCandidate(baseInput({
      fused: { total: 0.5, byLane: [] },
      laneRanks: LaneRanks.fromOutcomes([]),
    }))
    expect(rerankScore).toBeCloseTo(0.5 + 0.5 * ranking.overlapWeight, 14)
  })
})

describe('isProjectDoc (plan.rs vectors)', () => {
  it('matches the reference heuristic exactly', () => {
    for (const positive of [
      'README.md',
      'DESIGN.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'ARCHITECTURE.md',
      'readme.md',
      'Readme.md',
      guidePath,
      ['docs', 'adr', '0001-use-sqlite.md'].join('/'),
      'doc/api.md',
      'architecture/adr/0002-rrf-fusion.md',
      'decisions/adrs/0003-index-cache.md',
    ]) {
      expect(isProjectDoc(positive)).toBe(true)
    }
    for (const negative of [
      'src/main.rs',
      'src/lib.rs',
      'tests/test_main.rs',
      'src/deep/nested/notes.md',
      'README.txt',
    ]) {
      expect(isProjectDoc(negative)).toBe(false)
    }
  })
})

describe('dedupeReasons', () => {
  it('keeps first occurrences in emission order', () => {
    expect(dedupeReasons(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })
})

describe('per-branch edge cases of the additive table', () => {
  it('skips the symbol comparison entirely when no symbol name exists (gate on)', () => {
    const { rerankScore } = rerankCandidate(
      baseInput({ symbolName: null, gates: { ...DEFAULT_FEATURE_GATES, symbolExactEnabled: true } }),
    )
    let expected = 1.1 / 51
    expected += 0.5 * ranking.overlapWeight
    expect(rerankScore).toBeCloseTo(expected, 14)
  })

  it('compares case-insensitively and rejects non-matching names while gated on', () => {
    const matching = rerankCandidate(baseInput({ symbolName: 'USER', gates: { ...DEFAULT_FEATURE_GATES, symbolExactEnabled: true } }))
    expect(matching.reasons).toContain('symbol-exact')

    const notMatching = rerankCandidate(baseInput({ symbolName: 'Unrelated', gates: { ...DEFAULT_FEATURE_GATES, symbolExactEnabled: true } }))
    expect(notMatching.reasons).not.toContain('symbol-exact')
  })

  it.each([
    ['boostFiles', ranking.workingSetBoost, 'working-set-boost'],
    ['recentFiles', ranking.recentFileBoost, 'recent-file'],
    ['pinnedFiles', ranking.pinnedContextBoost, 'pinned-context'],
    ['overlayFiles', ranking.overlayNeighborBoost, 'overlay-neighbor'],
  ] as const)('applies $0 alone with its own reason token', (bucket, bonus, reason) => {
    const input = baseInput()
    const withBucket = { ...input, [bucket]: new Set(['src/a.ts']) } as typeof input
    const outcome = rerankCandidate(withBucket)
    let expected = 1.1 / 51
    expected += 0.5 * ranking.overlapWeight
    expected += bonus
    expect(outcome.rerankScore).toBeCloseTo(expected, 14)
    expect(outcome.reasons).toContain(reason)
  })

  it('keeps a stage-A bill silent when the preselect maps carry no entry for the file', () => {
    const { rerankScore, reasons } = rerankCandidate(baseInput({
      preselectResult: {
        files: ['src/a.ts'],
        scores: new Map([['src/a.ts', 2]]),
        reasons: new Map(),
        laneStats: { ftsHits: 0, tokenHits: 0, usedFallback: false },
        layerScores: new Map(),
      },
    }))
    // min(2 * 0.04, cap) contributes, but neither file reasons nor bills exist.
    let expected = 1.1 / 51
    expected += 0.5 * ranking.overlapWeight
    expected += Math.min(2 * ranking.stageAWeight, ranking.stageACap)
    expect(rerankScore).toBeCloseTo(expected, 14)
    expect(reasons.some(reason => reason.startsWith('preselect:'))).toBe(false)
  })
})
