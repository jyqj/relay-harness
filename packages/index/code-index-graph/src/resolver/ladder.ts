/**
 * The resolution ladder: the single declaration of the step order and the
 * cached query entry point, ported from the reference implementation's
 * `resolver/types.rs` (`RESOLVE_LADDER`) and `resolve_core.rs`
 * (`resolve_name` / `resolve_name_inner`).
 *
 * @module ladder
 */

import { resolveMemoKey } from './catalog-cache.ts'
import type { SymbolCatalog } from './catalog.ts'
import { globalUniquePool, stepGlobalUnique, stepImport, stepSameFile, stepScopeBinding, stepSelfMember, stepSuffix } from './steps-proof.ts'
import type { LadderContext, ResolveResult, StepOutcome } from './steps-proof.ts'
import { stepFuzzyArgCount, stepFuzzyImportDistance, stepFuzzyReceiver } from './steps-fuzzy.ts'
import { strategyForResult } from './penalties.ts'
import type { CallSiteSignals, CatalogScope, ImportBinding, ResolveStep, StrategyName } from '../types.ts'

/**
 * The resolution ladder in evaluation order (`RESOLVE_LADDER`). The
 * signal-driven steps sit between `global_unique` and the import-distance
 * fallback so call-site evidence outranks pure path proximity.
 */
export const RESOLVE_LADDER: readonly ResolveStep[] = Object.freeze([
  'self_member',
  'scope_binding',
  'same_file',
  'import',
  'suffix',
  'global_unique',
  'fuzzy_arg_count',
  'fuzzy_receiver',
  'fuzzy_import_distance',
])

/** One full resolution query as the ladder consumes it. */
export interface ResolveQuery {
  /** Dotted name as written at the reference site, trimmed before use. */
  readonly name: string
  /** File the resolution runs from. */
  readonly file: string
  /** Call-site line. */
  readonly line: number
  /** Scope map of the file set (empty: the binding step stays dormant). */
  readonly scopes: ReadonlyMap<string, CatalogScope>
  /** Import bindings of the resolving file. */
  readonly imports: readonly ImportBinding[]
  /** Enclosing declaration name, when known. */
  readonly container: string | null
  /** Per-call-site disambiguation signals; empty signals reproduce signal-free resolution. */
  readonly signals: CallSiteSignals
}

/**
 * Run the ladder for one name. The memo key includes the call-site line only
 * when the scope map is non-empty — the line influences resolution
 * exclusively through scope lookups, so with an empty scope map every line
 * shares one memo entry per distinct query.
 *
 * @param catalog - Catalog to resolve against.
 * @param query - The resolution query.
 * @returns The winning result, or `null` when the ladder resolved nothing.
 */
export function resolveName(catalog: SymbolCatalog, query: ResolveQuery): ResolveResult | null {
  const trimmed = query.name.trim()
  if (trimmed === '') return null

  const scopedLine = query.scopes.size > 0 ? query.line : null
  const key = resolveMemoKey(
    trimmed,
    query.file,
    scopedLine,
    query.container,
    query.signals.argCount,
    query.signals.receiver,
  )
  const cached = catalog.memo.get(key)
  if (cached !== undefined) return cached

  const result = resolveNameInner(catalog, {
    parts: trimmed.split('.'),
    leaf: trimmed.slice(trimmed.lastIndexOf('.') + 1),
    name: trimmed,
    file: query.file,
    line: query.line,
    scopes: query.scopes,
    imports: query.imports,
    container: query.container,
    signals: query.signals,
  })
  catalog.memo.put(key, result)
  return result
}

/**
 * Core uncached ladder walk. The fuzzy candidate pool is populated at
 * `global_unique` (which inspects the same by-name bucket), narrowed in place
 * by the signal steps so each later step sees the previous step's survivors,
 * and `fuzzyTotal` keeps the pre-narrowing count for candidate-count
 * reporting.
 *
 * @param catalog - Catalog to resolve against.
 * @param ctx - Fully derived ladder context.
 * @returns The winning result, or `null` when every step continued or the
 * ladder aborted.
 */
function resolveNameInner(catalog: SymbolCatalog, ctx: LadderContext): ResolveResult | null {
  let pool: number[] | null = null
  let fuzzyTotal = 0

  for (const step of RESOLVE_LADDER) {
    let outcome: StepOutcome
    switch (step) {
      case 'self_member':
        outcome = stepSelfMember(catalog, ctx)
        break
      case 'scope_binding':
        outcome = stepScopeBinding(catalog, ctx)
        break
      case 'same_file':
        outcome = stepSameFile(catalog, ctx)
        break
      case 'import':
        outcome = stepImport(catalog, ctx)
        break
      case 'suffix':
        outcome = stepSuffix(catalog, ctx)
        break
      case 'global_unique': {
        pool = globalUniquePool(catalog, ctx.leaf)
        fuzzyTotal = pool.length
        outcome = stepGlobalUnique(catalog, ctx, pool)
        break
      }
      case 'fuzzy_arg_count':
        // GlobalUnique precedes the fuzzy steps, so the pool always exists here.
        outcome = stepFuzzyArgCount(catalog, ctx, pool as number[], fuzzyTotal)
        break
      case 'fuzzy_receiver':
        outcome = stepFuzzyReceiver(catalog, ctx, pool as number[], fuzzyTotal)
        break
      case 'fuzzy_import_distance':
        outcome = stepFuzzyImportDistance(catalog, ctx, pool as number[], fuzzyTotal)
        break
    }

    if (outcome.outcome === 'resolved') return outcome.result
    if (outcome.outcome === 'abort') return null
  }

  return null
}

/**
 * Strategy label for a ladder result: signal-narrowed fuzzy wins get
 * step-specific labels (`fuzzy_arg_count` / `fuzzy_receiver`); every other
 * step keeps the kind-level label.
 *
 * @param result - The winning result.
 * @returns The stored `resolution_strategy` value.
 */
export function strategyOfResult(result: ResolveResult): StrategyName {
  return strategyForResult(result.resolutionKind, result.winningStep)
}
