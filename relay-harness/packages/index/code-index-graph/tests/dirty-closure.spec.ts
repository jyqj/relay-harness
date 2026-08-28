/**
 * Fixpoint dirty-closure policy contracts, ported from the reference
 * implementation's `dirty_closure.rs` tests: transitive promotion, the
 * strictly-greater-than global budget (round-1 bail vs later-round
 * truncation), exactly-at-budget convergence, same-round sibling re-export
 * chains, import cycles, the round cap, and the status vocabulary.
 */

import { describe, expect, it } from 'vitest'
import { DIRTY_CLOSURE_MAX_ROUNDS, closureStatusOf, computeDirtyClosure } from '../src/dirty/closure.ts'
import type { DirtyClosureInput } from '../src/dirty/closure.ts'

/** Build an `findImportersOf` hook from a static file → importers map. */
function importersFromMap(graph: Readonly<Record<string, readonly string[]>>): DirtyClosureInput['findImportersOf'] {
  return files => files.flatMap(file => graph[file] ?? [])
}

function promotable(set: readonly string[]): DirtyClosureInput['isPromotable'] {
  return path => set.includes(path)
}

/** Surface hook flipping every candidate unconditionally (chain-friendliest). */
function surfaceAlwaysFlips(): DirtyClosureInput['promotedExportSurfacesChanged'] {
  return files => files
}

/** Surface hook driven by a file → re-export targets map (production check). */
function surfaceFromReexports(
  targets: Readonly<Record<string, readonly string[]>>,
): DirtyClosureInput['promotedExportSurfacesChanged'] {
  return (files, changed) => files.filter(path => (targets[path] ?? []).some(target => changed.has(target)))
}

describe('computeDirtyClosure', () => {
  it('promotes transitive importers across surface-change rounds', () => {
    const result = computeDirtyClosure({
      seeds: ['b.ts'],
      maxFiles: 100,
      findImportersOf: importersFromMap({ 'b.ts': ['a.ts'], 'a.ts': ['c.ts'] }),
      isPromotable: promotable(['a.ts', 'c.ts']),
      promotedExportSurfacesChanged: surfaceFromReexports({ 'a.ts': ['b.ts'] }),
    })

    expect(result.budgetExceeded).toBe(false)
    expect(result.partial).toBe(false)
    expect(result.promoted).toEqual(['a.ts', 'c.ts'])
    expect(result.marked).toBe(2)
    expect(result.roundsRun).toBe(2)
    expect(result.status).toBe('normal')
  })

  it('keeps a budget-sized deterministic prefix when round one alone exceeds the budget', () => {
    const result = computeDirtyClosure({
      seeds: ['b.ts'],
      maxFiles: 2,
      findImportersOf: importersFromMap({ 'b.ts': ['a1.ts', 'a2.ts', 'a3.ts'] }),
      isPromotable: promotable(['a1.ts', 'a2.ts', 'a3.ts']),
      promotedExportSurfacesChanged: () => [],
    })

    expect(result.budgetExceeded).toBe(true)
    expect(result.promoted).toEqual(['a1.ts', 'a2.ts'])
    expect(result.marked).toBe(2)
    expect(result.partial).toBe(false)
    expect(result.status).toBe('budget_exceeded')
  })

  it('truncates to complete rounds when a later round exceeds the budget', () => {
    const result = computeDirtyClosure({
      seeds: ['b.ts'],
      maxFiles: 2,
      findImportersOf: importersFromMap({ 'b.ts': ['a1.ts'], 'a1.ts': ['a2.ts'], 'a2.ts': ['a3.ts'] }),
      isPromotable: promotable(['a1.ts', 'a2.ts', 'a3.ts']),
      promotedExportSurfacesChanged: surfaceAlwaysFlips(),
    })

    expect(result.budgetExceeded).toBe(false)
    expect(result.promoted).toEqual(['a1.ts', 'a2.ts'])
    expect(result.partial).toBe(true)
    expect(result.status).toBe('partial_closure')
  })

  it('allows promotions exactly at the budget (strictly-greater-than check)', () => {
    const result = computeDirtyClosure({
      seeds: ['b.ts'],
      maxFiles: 2,
      findImportersOf: importersFromMap({ 'b.ts': ['a1.ts'], 'a1.ts': ['a2.ts'] }),
      isPromotable: promotable(['a1.ts', 'a2.ts']),
      promotedExportSurfacesChanged: surfaceAlwaysFlips(),
    })

    expect(result.budgetExceeded).toBe(false)
    expect(result.partial).toBe(false)
    expect(result.promoted).toHaveLength(2)
    expect(result.status).toBe('normal')
  })

  it('reevaluates promoted siblings so same-round re-export chains reach their importers', () => {
    // b changes; z re-exports b; a imports b AND re-exports z; c imports a.
    // Both a and z are promoted in round 1, but a sorts BEFORE z, so a's
    // surface check against the pre-round changed set ({b}) is false — only
    // after z flips must a be re-evaluated and flip too, so that c is
    // promoted.
    const result = computeDirtyClosure({
      seeds: ['b.ts'],
      maxFiles: 100,
      findImportersOf: importersFromMap({
        'b.ts': ['z.ts', 'a.ts'],
        'z.ts': ['a.ts'],
        'a.ts': ['c.ts'],
      }),
      isPromotable: promotable(['z.ts', 'a.ts', 'c.ts']),
      promotedExportSurfacesChanged: surfaceFromReexports({ 'z.ts': ['b.ts'], 'a.ts': ['z.ts'] }),
    })

    expect(result.budgetExceeded).toBe(false)
    expect(result.partial).toBe(false)
    expect(result.promoted).toEqual(['a.ts', 'z.ts', 'c.ts'])
  })

  it('converges on import cycles, promoting each member exactly once', () => {
    const result = computeDirtyClosure({
      seeds: ['d.ts'],
      maxFiles: 100,
      findImportersOf: importersFromMap({
        'd.ts': ['x.ts', 'y.ts'],
        'x.ts': ['y.ts'],
        'y.ts': ['x.ts'],
      }),
      isPromotable: promotable(['x.ts', 'y.ts']),
      promotedExportSurfacesChanged: surfaceAlwaysFlips(),
    })

    expect(result.budgetExceeded).toBe(false)
    expect(result.partial).toBe(false)
    expect(result.promoted).toEqual(['x.ts', 'y.ts'])
    expect(result.roundsRun).toBe(2)
  })

  it('stops at the round cap with the partial complete-round closure', () => {
    const chain = Array.from({ length: 20 }, (_, index) => `f${index}.ts`)
    const graph: Record<string, string[]> = {}
    for (let index = 0; index < chain.length - 1; index++) {
      graph[chain[index] as string] = [chain[index + 1] as string]
    }
    const first = chain[0] as string

    const result = computeDirtyClosure({
      seeds: [first],
      maxFiles: 1000,
      findImportersOf: importersFromMap(graph),
      isPromotable: path => path !== first,
      promotedExportSurfacesChanged: surfaceAlwaysFlips(),
    })

    expect(result.partial).toBe(true)
    expect(result.budgetExceeded).toBe(false)
    expect(result.promoted).toHaveLength(DIRTY_CLOSURE_MAX_ROUNDS)
    expect(result.roundsRun).toBe(DIRTY_CLOSURE_MAX_ROUNDS)
    expect(result.status).toBe('partial_closure')
  })

  it('stops the inner surface fixpoint when a hook reports files outside the candidates', () => {
    // Defensive contract: a misbehaving hook naming a non-candidate file
    // cannot make the inner loop spin; the closure keeps the round boundary.
    const result = computeDirtyClosure({
      seeds: ['b.ts'],
      maxFiles: 100,
      findImportersOf: importersFromMap({ 'b.ts': ['a.ts'] }),
      isPromotable: promotable(['a.ts']),
      promotedExportSurfacesChanged: () => ['ghost.ts'],
    })

    expect(result.promoted).toEqual(['a.ts'])
    expect(result.roundsRun).toBe(1)
    expect(result.status).toBe('normal')
  })

  it('reports a trivially converged empty closure for seedless input', () => {
    const result = computeDirtyClosure({
      seeds: [],
      maxFiles: 0,
      findImportersOf: () => [],
      isPromotable: () => true,
      promotedExportSurfacesChanged: () => [],
    })

    expect(result.promoted).toEqual([])
    expect(result.marked).toBe(0)
    expect(result.roundsRun).toBe(0)
    expect(result.status).toBe('normal')
  })
})

describe('closureStatusOf', () => {
  it('classifies the three closure endings with budget_exceeded taking precedence', () => {
    expect(closureStatusOf(false, false)).toBe('normal')
    expect(closureStatusOf(false, true)).toBe('partial_closure')
    expect(closureStatusOf(true, false)).toBe('budget_exceeded')
  })
})
