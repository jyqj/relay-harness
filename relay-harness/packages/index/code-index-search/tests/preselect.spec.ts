import { describe, expect, it } from 'vitest'
import {
  LAYER_EXPLICIT_SCOPE,
  LAYER_FALLBACK,
  LAYER_FTS_SUMMARY,
  LAYER_OVERLAY,
  LAYER_PINNED,
  LAYER_RECENT,
  LAYER_TOKEN_SEARCH,
  LAYER_WORKING_SET,
  defaultPreselectLayers,
  preselect,
} from '../src/preselect.layers.ts'
import { DEFAULT_RANKING_CONFIG } from '../src/config.ts'
import type { PreselectLayer } from '../src/types.ts'
import { InMemoryIndex } from './fake-index.ts'

const ranking = DEFAULT_RANKING_CONFIG

type PreselectReq = Parameters<typeof preselect>[0]

function baseReq(port: InstanceType<typeof InMemoryIndex>, over: Partial<PreselectReq> = {}): PreselectReq {
  return {
    port,
    query: 'user',
    pathPrefix: null,
    boostFilePaths: null,
    recentFilePaths: null,
    pinnedFilePaths: null,
    overlayFilePaths: null,
    explicitFilePaths: null,
    limit: 10,
    ranking,
    ...over,
  }
}

describe('preselect layer registry order', () => {
  it('keeps the historical execution order without the P2 graph layer', () => {
    expect(defaultPreselectLayers().map(layer => layer.name)).toEqual([
      LAYER_WORKING_SET,
      LAYER_RECENT,
      LAYER_PINNED,
      LAYER_OVERLAY,
      LAYER_FTS_SUMMARY,
      LAYER_TOKEN_SEARCH,
      LAYER_FALLBACK,
    ])
    // Only the gate-reading layers look at prior scores.
    const reads = defaultPreselectLayers().map(layer => layer.readsPriorScores())
    expect(reads).toEqual([false, false, false, false, false, false, true])
  })

  it('runs a composed layer list instead of the built-ins when the request carries one', () => {
    const index = new InMemoryIndex().addFile('src/a.ts', '')
    const composed: PreselectLayer[] = [
      { name: 'only-layer', readsPriorScores: () => false, score: () => [{ filePath: 'src/a.ts', score: 3, reason: 'only-layer' }] },
    ]
    const result = preselect(baseReq(index, { query: '', layers: composed }))
    expect(result.files).toEqual(['src/a.ts'])
    expect(result.scores.get('src/a.ts')).toBe(3)
    expect(result.layerScores.get('src/a.ts')).toEqual([['only-layer', 3]])
  })
})

describe('rank-decay layers (max(floor, scale / rank))', () => {
  it('scores each list with its own floor/scale', () => {
    const index = new InMemoryIndex().addFile('src/ws.rs', '')
    const result = preselect(baseReq(index, {
      query: '',
      boostFilePaths: ['src/a.rs', 'src/b.rs'],
      recentFilePaths: ['src/r1.rs', 'src/r2.rs', 'src/r3.rs'],
      pinnedFilePaths: ['src/p.rs'],
      overlayFilePaths: ['src/o.rs'],
      limit: 10,
    }))
    // working-set rank 1: max(2.0, 5.0/1) = 5; rank 2: max(2.0, 2.5)
    expect(result.scores.get('src/a.rs')).toBeCloseTo(5.0)
    expect(result.scores.get('src/b.rs')).toBeCloseTo(2.5)
    // recent ranks decay under floor after two positions: max(1.2, 3.5/rank)
    expect(result.scores.get('src/r3.rs')).toBeCloseTo(1.2)
    // pinned rank 1: max(2.2, 4.0)
    expect(result.scores.get('src/p.rs')).toBeCloseTo(4.0)
    // overlay rank 1: max(1.5, 3.0)
    expect(result.scores.get('src/o.rs')).toBeCloseTo(3.0)
    // Reasons arrive in layer emission order.
    expect(result.reasons.get('src/p.rs')).toEqual([LAYER_PINNED])
  })

  it('bills per-layer totals that sum to the file score and dedupes reasons', () => {
    const index = new InMemoryIndex()
      .addFile('src/a.ts', '')
      .addFile('a_user.go', 'user')
      .addSymbol('src/a.ts', 'getUserById')
      .addSymbol('src/a.ts', 'loadUser')
    const result = preselect(baseReq(index, {
      boostFilePaths: ['src/a.ts', 'src\\win.rs'],
      recentFilePaths: ['src/a.ts'],
      limit: 10,
    }))
    const bill = result.layerScores.get('src/a.ts')!
    let sum = 0
    for (const [, value] of bill) sum += value
    expect(sum).toBeCloseTo(result.scores.get('src/a.ts')!)
    expect(bill.map(([layer]) => layer)).toEqual([LAYER_WORKING_SET, LAYER_RECENT, LAYER_TOKEN_SEARCH])
    // Two same-layer symbol hits aggregate into one bill entry but keep both reasons.
    expect(result.reasons.get('src/a.ts')).toContain('symbol:getUserById')
    expect(result.reasons.get('src/a.ts')).toContain('symbol:loadUser')
    expect(result.layerScores.get('src/a.ts')!.at(-1)).toEqual([LAYER_TOKEN_SEARCH, 2.4])
    // Backslash paths normalize to slashes.
    expect(result.files).toContain('src/win.rs')
  })


  it('emits path-token hits with the historical reason format', () => {
    const index = new InMemoryIndex()
      .addFile('src/widgetstore/a.ts', '')
      .addFile('src/b.ts', '')
    const result = preselect(baseReq(index, { query: 'widget' }))
    expect(result.files).toContain('src/widgetstore/a.ts')
    expect(result.reasons.get('src/widgetstore/a.ts')).toContain('path-token:widget')
    expect(result.laneStats.tokenHits).toBeGreaterThan(0)
    expect(result.laneStats.usedFallback).toBe(false)
  })

  it('prefers the exact-name bonus over fuzzy for equal names', () => {
    const index = new InMemoryIndex()
      .addFile('src/x.ts', '')
      .addSymbol('src/x.ts', 'Widget')
      .addSymbol('src/x.ts', 'WidgetFactory')
    const result = preselect(baseReq(index, { query: 'widget' }))
    const bill = result.layerScores.get('src/x.ts')!
    const tokenBill = bill.find(([layer]) => layer === LAYER_TOKEN_SEARCH)
    // exact 2.0 + fuzzy 1.2 on one file
    expect(tokenBill?.[1]).toBeCloseTo(3.2)
  })

  it('keeps symbol hits when the path-token lookup rejects, and vice versa', () => {
    const noPath = new InMemoryIndex()
      .addFile('src/sym.ts', '')
      .addSymbol('src/sym.ts', 'UserRepo')
    ;(noPath as unknown as Record<string, unknown>).filePathCandidatesBySubstring = () => {
      throw new Error('path mirror down')
    }
    const viaSymbols = preselect(baseReq(noPath, { query: 'userrepo' }))
    expect(viaSymbols.reasons.get('src/sym.ts')).toContain('symbol:UserRepo')
    expect(viaSymbols.layerScores.get('src/sym.ts')?.some(([layer]) => layer === LAYER_TOKEN_SEARCH)).toBe(true)

    const noSymbols = new InMemoryIndex()
      .addFile('src/pathton.ts', '')
    ;(noSymbols as unknown as Record<string, unknown>).symbolNamesByTokenSubstring = () => {
      throw new Error('symbols mirror down')
    }
    const viaPaths = preselect(baseReq(noSymbols, { query: 'pathton' }))
    expect(viaPaths.reasons.get('src/pathton.ts')).toContain('path-token:pathton')
    expect(viaPaths.files).toContain('src/pathton.ts')
  })
})

describe('FTS summary layer', () => {
  it('short-circuits a blank sanitized query and swallows port failures silently', () => {
    const index = new InMemoryIndex().addFile('notes/a.md', 'auth login flow')
    const blank = preselect(baseReq(index, { query: '' }))
    expect(blank.laneStats.ftsHits).toBe(0)

    const broken: InMemoryIndex = new InMemoryIndex().addFile('notes/b.md', 'auth flow')
    ;(broken as unknown as Record<string, unknown>).ftsFileSummaries = () => {
      throw new Error('boom')
    }
    const degraded = preselect(baseReq(broken))
    expect(degraded.laneStats.ftsHits).toBe(0)
    // The gated fallback still supplies recently-indexed files.
    expect(degraded.files.length).toBeGreaterThan(0)
  })

  it('scores base + 1/(1+|bm25|): larger bm25 distance lowers the layer score', () => {
    const index = new InMemoryIndex()
      .addFile('notes/one.md', 'auth login')
      .addFile('notes/only.md', 'login login login')
    const result = preselect(baseReq(index, { query: 'auth login' }))
    // The fake store emits rawScore = -matchedTerms: 'only.md' matched one
    // term (distance 1 → +1.5 total), 'one.md' matched two (distance 2 →
    // +1.733…). Ranking still sorts layer scores descending, so the nearer
    // doc leads.
    expect(result.laneStats.ftsHits).toBe(2)
    expect(result.files[0]).toBe('notes/only.md')
    expect(result.scores.get('notes/one.md')).toBeCloseTo(ranking.preselectFtsBase + 1 / 3)
    expect(result.scores.get('notes/only.md')).toBeCloseTo(ranking.preselectFtsBase + 1 / 2)
  })
})

describe('explicit scope short circuit and fallback gate', () => {
  it('silently keeps zero files when the fallback query rejects against an empty score set', () => {
    const index = new InMemoryIndex().addFile('src/gone.ts', '')
    ;(index as unknown as Record<string, unknown>).recentIndexedFiles = () => {
      throw new Error('recency cursor lost')
    }
    const result = preselect(baseReq(index, { query: 'zzznothing' }))
    expect(result.files).toEqual([])
    expect(result.laneStats.usedFallback).toBe(true)
  })

  it('deduplicates repeated reason tokens at finalize time', () => {
    const index = new InMemoryIndex()
      .addFile('src/twin.ts', '')
      .addSymbol('src/twin.ts', 'UserRepo')
      .addSymbol('src/twin.ts', 'UserRepo')
    const result = preselect(baseReq(index, { query: 'userrepo' }))
    // Two identical symbol hits → two identical reasons, one survives.
    expect(result.reasons.get('src/twin.ts')?.filter(reason => reason === 'symbol:UserRepo')).toHaveLength(1)
  })

  it('returns explicit files at the explicit score with its own bill entry', () => {
    const index = new InMemoryIndex()
      .addFile('src/a.rs', '')
      .addFile('src/b.rs', '')
    const result = preselect(baseReq(index, { explicitFilePaths: ['src/a.rs', 'src/b.rs'] }))
    expect(result.files).toEqual(['src/a.rs', 'src/b.rs'])
    expect(result.scores.get('src/a.rs')).toBe(10.0)
    expect(result.laneStats).toEqual({ ftsHits: 0, tokenHits: 0, usedFallback: false })
    expect(result.layerScores.get('src/a.rs')).toEqual([[LAYER_EXPLICIT_SCOPE, 10.0]])
    expect(result.reasons.get('src/a.rs')).toEqual([LAYER_EXPLICIT_SCOPE])
  })

  it('falls back to recently-indexed files only when nothing scored', () => {
    const index = new InMemoryIndex()
      .addFile('src/recent1.ts', '')
      .addFile('src/recent2.ts', '')
      .addFile('src/matched.ts', 'needle content')
    const fallback = preselect(baseReq(index, { query: 'zzznotfound', limit: 10 }))
    expect(fallback.laneStats.usedFallback).toBe(true)
    for (const file of fallback.files) {
      expect(fallback.scores.get(file)).toBeCloseTo(0.2)
      expect(fallback.reasons.get(file)).toContain(LAYER_FALLBACK)
    }

    const gated = preselect(baseReq(index, { query: 'needle' }))
    expect(gated.laneStats.usedFallback).toBe(false)
  })

  it('respects pathPrefix filtering and sorts by score desc then path asc', () => {
    const index = new InMemoryIndex()
      .addFile('src/widget/a.ts', 'widget widget widget')
      .addFile('lib/widget/b.ts', 'widget widget widget')
    const result = preselect(baseReq(index, { query: 'widget', pathPrefix: 'src/' }))
    expect(result.files).toEqual(['src/widget/a.ts'])
  })
})
