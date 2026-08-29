/**
 * The fuzzy-multi ladder steps: the shared by-name candidate pool's signal
 * narrowing and import-distance tie-breaking, ported one-to-one from the
 * reference implementation's `resolver/resolve_core.rs`. Each step answers
 * {@link StepOutcome}: resolved (stop the ladder) or continue (nothing found
 * — try the next step).
 *
 * @module steps-fuzzy
 */

import type { CatalogEntry, SymbolCatalog } from './catalog.ts'
import { BASE_CONFIDENCE, bestByImportDistance, candidateCountPenalty, isImportReachable } from './penalties.ts'
import type { ImportBinding } from '../types.ts'
import type { ResolveStep } from '../types.ts'
import { CONTINUE } from './steps-proof.ts'
import type { LadderContext, StepOutcome } from './steps-proof.ts'

/**
 * If a signal step narrowed the fuzzy pool to exactly one candidate, that
 * candidate wins at `fuzzy_signal` confidence with a 0.5x penalty when the
 * winner is not import-reachable (`fuzzy_signal_winner`).
 *
 * @param catalog - Catalog backing the candidate entries.
 * @param pool - The surviving fuzzy pool.
 * @param fuzzyTotal - Pre-narrowing pool size, reported as candidate count.
 * @param step - The signal step claiming the win.
 * @param imports - Import bindings of the resolving file.
 * @returns The resolved outcome, or continue when the pool is not a single.
 */
export function fuzzySignalWinner(
  catalog: SymbolCatalog,
  pool: readonly number[],
  fuzzyTotal: number,
  step: ResolveStep,
  imports: readonly ImportBinding[],
): StepOutcome {
  if (pool.length !== 1) return CONTINUE
  const idx = pool[0] as number
  let confidence = BASE_CONFIDENCE.fuzzy_signal
  if (imports.length > 0 && !isImportReachable((catalog.entries[idx] as CatalogEntry).filePath, imports)) {
    confidence *= 0.5
  }
  return {
    outcome: 'resolved',
    result: {
      catalogIndex: idx,
      resolutionKind: 'fuzzy_signal',
      confidence,
      candidateCount: fuzzyTotal,
      winningStep: step,
    },
  }
}

/**
 * Narrow a fuzzy pool by the call's argument count
 * (`narrow_fuzzy_by_arg_count`): exact arity first, then defaulted trailing
 * params (`param_count > arg_count`); metadata-less candidates are wildcards
 * that evidence can rule in but never out.
 *
 * @param catalog - Catalog whose embedded type catalog provides arity data.
 * @param pool - The fuzzy pool, narrowed in place by the caller on return.
 * @param leaf - Final segment of the queried name.
 * @param argCount - Argument count at the call site.
 * @returns The narrowed pool, or the input pool when nothing narrowed.
 */
export function narrowByArgCount(
  catalog: SymbolCatalog,
  pool: number[],
  leaf: string,
  argCount: number,
): number[] {
  const tc = catalog.typeCatalog
  if (tc === null) return pool
  const exact: number[] = []
  const defaulted: number[] = []
  const wildcard: number[] = []
  for (const idx of pool) {
    const uid = (catalog.entries[idx] as CatalogEntry).symbolUid
    const known = uid === null ? undefined : tc.methodParamCount(leaf, uid)
    if (known === undefined) wildcard.push(idx)
    else if (known === argCount) exact.push(idx)
    else if (known > argCount) defaulted.push(idx)
  }
  const matched = exact.length > 0 ? exact : defaulted
  if (matched.length === 0) return pool
  matched.push(...wildcard)
  if (matched.length < pool.length) return matched
  return pool
}

/**
 * Narrow a fuzzy pool by the call's receiver expression
 * (`narrow_fuzzy_by_receiver`): only a positive incompatibility verdict
 * eliminates a candidate, and narrowing requires at least one positively
 * compatible survivor — the one-level subtype check can be a false negative,
 * so elimination-only evidence is too weak to discard candidates.
 *
 * @param catalog - Catalog whose embedded type catalog provides receiver data.
 * @param pool - The fuzzy pool, narrowed in place by the caller on return.
 * @param leaf - Final segment of the queried name.
 * @param file - File the resolution runs from (for variable type lookup).
 * @param receiver - Receiver expression as written.
 * @returns The narrowed pool, or the input pool when nothing narrowed.
 */
export function narrowByReceiver(
  catalog: SymbolCatalog,
  pool: number[],
  leaf: string,
  file: string,
  receiver: string,
): number[] {
  const tc = catalog.typeCatalog
  if (tc === null) return pool
  // A bare variable receiver may have a recorded type assignment; prefer the
  // inferred type over the raw expression.
  const receiverHint = tc.resolveVarType(file, receiver) ?? receiver
  const verdicts = pool.map((idx) => {
    const uid = (catalog.entries[idx] as CatalogEntry).symbolUid
    return { idx, compat: uid === null ? undefined : tc.methodReceiverCompat(leaf, uid, receiverHint) }
  })
  const anyPositive = verdicts.some(verdict => verdict.compat === true)
  const matched = verdicts.filter(verdict => verdict.compat !== false).map(verdict => verdict.idx)
  if (anyPositive && matched.length > 0 && matched.length < pool.length) return matched
  return pool
}

/**
 * `FuzzyArgCount` step: narrow the shared pool with the call's argument
 * count, then claim a single survivor at `fuzzy_signal` confidence.
 *
 * @param catalog - Catalog backing the candidate entries.
 * @param ctx - The ladder context.
 * @param pool - The shared fuzzy pool, narrowed in place.
 * @param fuzzyTotal - Pre-narrowing pool size, reported as candidate count.
 * @returns Resolved on a single survivor, or continue.
 */
export function stepFuzzyArgCount(
  catalog: SymbolCatalog,
  ctx: LadderContext,
  pool: number[],
  fuzzyTotal: number,
): StepOutcome {
  const argCount = ctx.signals.argCount
  if (argCount === null || pool.length <= 1) return CONTINUE
  const narrowed = narrowByArgCount(catalog, pool, ctx.leaf, argCount)
  if (narrowed !== pool) {
    pool.length = 0
    pool.push(...narrowed)
  }
  return fuzzySignalWinner(catalog, pool, fuzzyTotal, 'fuzzy_arg_count', ctx.imports)
}

/**
 * `FuzzyReceiver` step: narrow the shared pool with the call's receiver
 * expression, then claim a single survivor at `fuzzy_signal` confidence.
 *
 * @param catalog - Catalog backing the candidate entries.
 * @param ctx - The ladder context.
 * @param pool - The shared fuzzy pool, narrowed in place.
 * @param fuzzyTotal - Pre-narrowing pool size, reported as candidate count.
 * @returns Resolved on a single survivor, or continue.
 */
export function stepFuzzyReceiver(
  catalog: SymbolCatalog,
  ctx: LadderContext,
  pool: number[],
  fuzzyTotal: number,
): StepOutcome {
  const receiver = ctx.signals.receiver
  if (receiver === null || pool.length <= 1) return CONTINUE
  const narrowed = narrowByReceiver(catalog, pool, ctx.leaf, ctx.file, receiver)
  if (narrowed !== pool) {
    pool.length = 0
    pool.push(...narrowed)
  }
  return fuzzySignalWinner(catalog, pool, fuzzyTotal, 'fuzzy_receiver', ctx.imports)
}

/**
 * `FuzzyImportDistance` step: the pre-existing fuzzy-multi tie-breaking
 * (import reachability, then longest common path prefix) applied to the pool
 * surviving the signal steps. A single reachable survivor promotes the
 * winner to the `fuzzy_single` confidence anchor; a pool with no reachable
 * candidate takes an extra 0.5x penalty.
 *
 * @param catalog - Catalog backing the candidate entries.
 * @param ctx - The ladder context.
 * @param pool - The fuzzy pool surviving the signal steps.
 * @param fuzzyTotal - Pre-narrowing pool size, reported as candidate count.
 * @returns Resolved, or continue when the pool is smaller than two.
 */
export function stepFuzzyImportDistance(
  catalog: SymbolCatalog,
  ctx: LadderContext,
  pool: readonly number[],
  fuzzyTotal: number,
): StepOutcome {
  // Length 1 was claimed by an earlier fuzzy step; length 0 means the leaf
  // name is unknown.
  if (pool.length < 2) return CONTINUE
  const count = pool.length
  const penalized = candidateCountPenalty(BASE_CONFIDENCE.fuzzy_multi, count)

  const reachable = ctx.imports.length > 0
    ? pool.filter(idx => isImportReachable((catalog.entries[idx] as CatalogEntry).filePath, ctx.imports))
    : []

  // pool.length >= 2 here, so both distance picks always return a winner.
  let chosen: number
  let confidence: number
  if (reachable.length === 1) {
    chosen = reachable[0] as number
    confidence = candidateCountPenalty(BASE_CONFIDENCE.fuzzy_single, count)
  } else if (reachable.length > 0) {
    chosen = bestByImportDistance(catalog.entries, reachable, ctx.file) as number
    confidence = penalized
  } else {
    chosen = bestByImportDistance(catalog.entries, pool, ctx.file) as number
    confidence = penalized * 0.5
  }
  return {
    outcome: 'resolved',
    result: {
      catalogIndex: chosen,
      resolutionKind: 'fuzzy_multi',
      confidence,
      candidateCount: fuzzyTotal,
      winningStep: 'fuzzy_import_distance',
    },
  }
}
