import { describe, expect, it } from 'vitest'
import {
  repoSizeTierFromFileCount,
  repoSizeTierGraphEnrichLimits,
  repoSizeTierMaxOutputChars,
  repoSizeTierMaxSnippetChars,
  repoSizeTierSearchTopK,
  repoSizeTierTokenBudget,
} from '../src/tiers.ts'

describe('repo size tier classification', () => {
  it('classifies file counts at every exclusive boundary', () => {
    expect(repoSizeTierFromFileCount(0)).toBe('tiny')
    expect(repoSizeTierFromFileCount(499)).toBe('tiny')
    expect(repoSizeTierFromFileCount(500)).toBe('small')
    expect(repoSizeTierFromFileCount(4999)).toBe('small')
    expect(repoSizeTierFromFileCount(5000)).toBe('medium')
    expect(repoSizeTierFromFileCount(24999)).toBe('medium')
    expect(repoSizeTierFromFileCount(25000)).toBe('large')
  })
})

describe('tier adaptive constants', () => {
  it('returns verbatim search top-K per tier', () => {
    expect(repoSizeTierSearchTopK('tiny')).toBe(5)
    expect(repoSizeTierSearchTopK('small')).toBe(10)
    expect(repoSizeTierSearchTopK('medium')).toBe(15)
    expect(repoSizeTierSearchTopK('large')).toBe(20)
  })

  it('returns verbatim output character budgets per tier', () => {
    expect(repoSizeTierMaxOutputChars('tiny')).toBe(18_000)
    expect(repoSizeTierMaxOutputChars('small')).toBe(24_000)
    expect(repoSizeTierMaxOutputChars('medium')).toBe(32_000)
    expect(repoSizeTierMaxOutputChars('large')).toBe(38_000)
  })

  it('derives snippet budgets as floor(output/3)', () => {
    expect(repoSizeTierMaxSnippetChars('tiny')).toBe(6_000)
    expect(repoSizeTierMaxSnippetChars('small')).toBe(8_000)
    expect(repoSizeTierMaxSnippetChars('medium')).toBe(10_666)
    expect(repoSizeTierMaxSnippetChars('large')).toBe(12_666)
  })

  it('returns verbatim token budgets per tier', () => {
    expect(repoSizeTierTokenBudget('tiny')).toBe(4_000)
    expect(repoSizeTierTokenBudget('small')).toBe(6_000)
    expect(repoSizeTierTokenBudget('medium')).toBe(8_000)
    expect(repoSizeTierTokenBudget('large')).toBe(12_000)
  })

  it('returns verbatim graph-enrich limits per tier and freezes each entry', () => {
    expect(repoSizeTierGraphEnrichLimits('tiny')).toEqual({
      maxResolve: 3,
      callersPerSym: 2,
      calleesPerSym: 2,
      maxTests: 2,
      maxRoutes: 1,
      graphBudgetPct: 20,
    })
    expect(repoSizeTierGraphEnrichLimits('small')).toEqual({
      maxResolve: 5,
      callersPerSym: 3,
      calleesPerSym: 3,
      maxTests: 3,
      maxRoutes: 2,
      graphBudgetPct: 25,
    })
    expect(repoSizeTierGraphEnrichLimits('medium')).toEqual({
      maxResolve: 7,
      callersPerSym: 3,
      calleesPerSym: 3,
      maxTests: 4,
      maxRoutes: 2,
      graphBudgetPct: 25,
    })
    expect(repoSizeTierGraphEnrichLimits('large')).toEqual({
      maxResolve: 8,
      callersPerSym: 4,
      calleesPerSym: 4,
      maxTests: 5,
      maxRoutes: 3,
      graphBudgetPct: 30,
    })
    expect(Object.isFrozen(repoSizeTierGraphEnrichLimits('large'))).toBe(true)
  })
})
