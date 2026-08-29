/**
 * The nine ladder-step implementations, ported one-to-one from the reference
 * implementation's `resolver/resolve_core.rs`. Each step answers
 * {@link StepOutcome}: resolved (stop the ladder), continue (nothing found —
 * try the next step), or abort (authoritative for this name shape and failed).
 *
 * @module steps-proof
 */

import type { CatalogEntry, SymbolCatalog } from './catalog.ts'
import {
  BASE_CONFIDENCE,
  bestByImportDistance,
  candidateCountPenalty,
  dedupById,
  isImportReachable,
  pickUnique,
  scopeForLine,
  scopeDistance,
} from './penalties.ts'
import type { CallSiteSignals, CatalogScope, ImportBinding } from '../types.ts'
import type { InternalResKind, ResolveStep } from '../types.ts'

/** Result of one winning ladder step (the reference's `ResolveResult`). */
export interface ResolveResult {
  /** Index into {@link SymbolCatalog.entries} of the winning candidate. */
  readonly catalogIndex: number
  /** Internal resolution kind the winning step produced. */
  readonly resolutionKind: InternalResKind
  /** Winner confidence in `[0, 1]` after every penalty. */
  readonly confidence: number
  /**
   * Number of candidates the winning step considered (pre-narrowing for the
   * fuzzy steps); `1` for proof-based steps.
   */
  readonly candidateCount: number
  /** The ladder step that produced this result. */
  readonly winningStep: ResolveStep
}

/** Control flow of one ladder step. */
export type StepOutcome =
  | { readonly outcome: 'resolved'; readonly result: ResolveResult }
  | { readonly outcome: 'continue' }
  | { readonly outcome: 'abort' }

/** Everything one ladder step may read about the query. */
export interface LadderContext {
  /** Dot-split name segments. */
  readonly parts: readonly string[]
  /** Final segment of the name (the fuzzy pool's leaf). */
  readonly leaf: string
  /** Name as written, trimmed. */
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
  /** Per-call-site disambiguation signals. */
  readonly signals: CallSiteSignals
}

/** Result from a proof-based step: one candidate at the kind's base confidence. */
function single(catalogIndex: number, kind: InternalResKind, step: ResolveStep): StepOutcome {
  return {
    outcome: 'resolved',
    result: {
      catalogIndex,
      resolutionKind: kind,
      confidence: BASE_CONFIDENCE[kind],
      candidateCount: 1,
      winningStep: step,
    },
  }
}

/** Continue outcome singleton. */
export const CONTINUE: StepOutcome = { outcome: 'continue' }

/**
 * `SelfMember` step: `this.x` / `self.x` member resolution on the owner
 * class. Authoritative for this/self-prefixed names — a miss aborts the
 * ladder (a this/self reference never resolves to an unrelated global).
 *
 * @param catalog - Catalog to resolve against.
 * @param ctx - The ladder context.
 * @returns Resolved, continue for non-this/self names, or abort.
 */
export function stepSelfMember(catalog: SymbolCatalog, ctx: LadderContext): StepOutcome {
  const head = ctx.parts[0]
  const tail = ctx.parts.slice(1)
  if ((head !== 'this' && head !== 'self') || tail.length === 0) return CONTINUE
  const ownerQname = catalog.ownerClassQname(ctx.file, ctx.container)
  if (ownerQname === undefined) return { outcome: 'abort' }
  const memberQname = `${ownerQname}.${tail[0]}`
  const idx = pickUnique(catalog.entries, catalog.sameFileQname(ctx.file, memberQname))
  if (idx === undefined) return { outcome: 'abort' }
  if (tail.length === 1) return single(idx, 'exact', 'self_member')
  const finalIdx = catalog.resolveMemberChainFrom(idx, tail.slice(1), ctx.file)
  if (finalIdx !== undefined) return single(finalIdx, 'qualified', 'self_member')
  return single(idx, 'exact', 'self_member')
}

/**
 * `ScopeBinding` step: lexical scope-chain bindings; dormant while no parser
 * feeds scopes.
 *
 * @param catalog - Catalog to resolve against.
 * @param ctx - The ladder context.
 * @returns Resolved, or continue when no binding holds the name.
 */
export function stepScopeBinding(catalog: SymbolCatalog, ctx: LadderContext): StepOutcome {
  const idx = catalog.resolveViaScopeBindings(ctx.scopes, ctx.file, ctx.name, ctx.line)
  if (idx === undefined) return CONTINUE
  return single(idx, 'scope_resolved', 'scope_binding')
}

/**
 * Find the best same-file candidate, preferring scope proximity
 * (`best_same_file_candidate`): dotted names try exact qname then the member
 * chain; plain names try the owner-class member, then all same-file matches
 * ranked by (scope distance, qname length).
 *
 * @param catalog - Catalog to resolve against.
 * @param name - Dotted name as written.
 * @param file - File the resolution runs from.
 * @param scopes - Scope map of the file set.
 * @param line - Call-site line.
 * @param container - Enclosing declaration name, when known.
 * @returns The winning entry index, or `undefined`.
 */
export function bestSameFileCandidate(
  catalog: SymbolCatalog,
  name: string,
  file: string,
  scopes: ReadonlyMap<string, CatalogScope>,
  line: number,
  container: string | null,
): number | undefined {
  const parts = name.split('.')

  if (parts.length > 1) {
    const exact = pickUnique(catalog.entries, catalog.sameFileQname(file, name))
    if (exact !== undefined) return exact
    return catalog.resolveMemberChain(parts, file)
  }

  const short = parts[0] as string
  const ownerQname = catalog.ownerClassQname(file, container)
  if (ownerQname !== undefined) {
    const ownerMember = `${ownerQname}.${short}`
    const ownerIdx = pickUnique(catalog.entries, catalog.sameFileQname(file, ownerMember))
    if (ownerIdx !== undefined) return ownerIdx
  }

  const sameFile = catalog.sameFileNamed(file, short)
  if (sameFile.length === 0) return undefined

  const unique = dedupById(catalog.entries, sameFile)
  // sameFile is non-empty, so its deduplication is too.
  if (unique.length === 1) return unique[0]

  const currentScope = scopeForLine({ scopes, file, line })
  const currentScopeId = currentScope?.scopeId ?? null

  let best: number | undefined
  let bestKey: readonly [number, number] | undefined
  for (const idx of unique) {
    const entry = catalog.entries[idx] as CatalogEntry
    const scopeId = entry.scopeId
    const distance = (currentScopeId !== null && scopeId !== null)
      ? (scopeDistance(scopes, currentScopeId, scopeId) ?? 10_000)
      : 10_000
    const qlen = entry.qname?.length ?? entry.name.length
    if (bestKey === undefined || distance < bestKey[0] || (distance === bestKey[0] && qlen < bestKey[1])) {
      best = idx
      bestKey = [distance, qlen]
    }
  }
  return best
}

/**
 * `SameFile` step: a hit resolves as `qualified` for dotted names and
 * `scope_resolved` for plain names.
 *
 * @param catalog - Catalog to resolve against.
 * @param ctx - The ladder context.
 * @returns Resolved, or continue when no same-file candidate matches.
 */
export function stepSameFile(catalog: SymbolCatalog, ctx: LadderContext): StepOutcome {
  const idx = bestSameFileCandidate(catalog, ctx.name, ctx.file, ctx.scopes, ctx.line, ctx.container)
  if (idx === undefined) return CONTINUE
  return single(idx, ctx.parts.length > 1 ? 'qualified' : 'scope_resolved', 'same_file')
}

/**
 * `Import` step: bindings traced to their exporting module.
 *
 * @param catalog - Catalog to resolve against.
 * @param ctx - The ladder context.
 * @returns Resolved, or continue when no import binding holds the head.
 */
export function stepImport(catalog: SymbolCatalog, ctx: LadderContext): StepOutcome {
  const idx = catalog.resolveViaImports(ctx.imports, ctx.name)
  if (idx === undefined) return CONTINUE
  return single(idx, 'import_resolved', 'import')
}

/**
 * `Suffix` step: qualified-name suffix match (`pkg.mod.Func` ↔ `mod.Func`)
 * against the query's leaf bucket, capped by the ambiguity limit.
 *
 * @param catalog - Catalog to resolve against.
 * @param ctx - The ladder context.
 * @returns Resolved, or continue when no suffix match exists or the bucket
 * exceeds the ambiguity cap.
 */
export function stepSuffix(catalog: SymbolCatalog, ctx: LadderContext): StepOutcome {
  const name = ctx.name
  if (!name.includes('.')) return CONTINUE
  const needle = name.toLowerCase()
  const suffix = `.${needle}`
  const leaf = needle.slice(needle.lastIndexOf('.') + 1)
  const candidates = catalog.byQnameLeaf.get(leaf)
  if (candidates === undefined) return CONTINUE
  // Same cap as the fuzzy ladder: a leaf segment shared by more qnames than
  // the limit is too ambiguous for a suffix heuristic.
  if (candidates.length > catalog.maxFuzzyPool) return CONTINUE
  const matches: number[] = []
  for (const idx of candidates) {
    // Leaf-bucket membership implies a non-null qname (addSymbols registers
    // the bucket only for qname-bearing rows).
    const q = ((catalog.entries[idx] as CatalogEntry).qname as string).toLowerCase()
    if (q === needle || q.endsWith(suffix)) matches.push(idx)
  }
  const unique = dedupById(catalog.entries, matches)
  if (unique.length === 0) return CONTINUE
  // unique.length >= 1, so the distance pick always yields a winner.
  const idx = unique.length === 1 ? (unique[0] as number) : (bestByImportDistance(catalog.entries, unique, ctx.file) as number)

  return {
    outcome: 'resolved',
    result: {
      catalogIndex: idx,
      resolutionKind: 'suffix_match',
      confidence: candidateCountPenalty(BASE_CONFIDENCE.suffix_match, unique.length),
      candidateCount: unique.length,
      winningStep: 'suffix',
    },
  }
}

/**
 * The by-name fuzzy pool behind `GlobalUnique` and the fuzzy steps: the
 * lowercased leaf bucket deduplicated by symbol id, or empty when the bucket
 * exceeds the ambiguity cap (`resolve_name_inner`'s pool initialization).
 *
 * @param catalog - Catalog to resolve against.
 * @param leaf - Final segment of the queried name.
 * @returns The deduplicated candidate pool (possibly empty).
 */
export function globalUniquePool(catalog: SymbolCatalog, leaf: string): number[] {
  const candidates = catalog.byName.get(leaf.toLowerCase())
  if (candidates === undefined || candidates.length > catalog.maxFuzzyPool) return []
  return dedupById(catalog.entries, candidates)
}

/**
 * `GlobalUnique` step: a single-candidate pool wins at base confidence with a
 * 0.6x penalty when the winner is not import-reachable; the pool also seeds
 * the later fuzzy steps (global uniqueness is the single-candidate case of
 * the same by-name pool).
 *
 * @param catalog - Catalog backing the candidate entries.
 * @param ctx - The ladder context.
 * @param pool - The by-name candidate pool seeded at this step.
 * @returns Resolved on a single candidate, or continue.
 */
export function stepGlobalUnique(
  catalog: SymbolCatalog,
  ctx: LadderContext,
  pool: readonly number[],
): StepOutcome {
  if (pool.length !== 1) return CONTINUE
  const idx = pool[0] as number
  let confidence = BASE_CONFIDENCE.global_unique
  if (ctx.imports.length > 0 && !isImportReachable((catalog.entries[idx] as CatalogEntry).filePath, ctx.imports)) {
    confidence *= 0.6
  }
  return {
    outcome: 'resolved',
    result: {
      catalogIndex: idx,
      resolutionKind: 'global_unique',
      confidence,
      candidateCount: 1,
      winningStep: 'global_unique',
    },
  }
}

