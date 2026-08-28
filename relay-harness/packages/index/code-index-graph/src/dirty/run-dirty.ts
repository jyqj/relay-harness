/**
 * Dirty-propagation orchestration for an incremental build.
 *
 * Ported from the reference implementation's `indexer_phases/dirty.rs`:
 * compare the freshly committed export fingerprints against the pre-write
 * values, seed the closure with the changed files plus every removed or
 * renamed-away path, promote transitive importers through the fixpoint
 * closure, and re-resolve the promoted files' stored edges in place — their
 * content did not change, so only the resolution state rebuilds.
 *
 * The caller owns transaction folding: the re-resolution lands through
 * {@link reresolveDirtyFiles} as one epoch-bumped transaction whenever the
 * closure promoted at least one file; a converged or disabled closure writes
 * nothing and moves no epoch.
 *
 * @module @relay-harness/rlh-code-index-graph/dirty/run-dirty
 */

import type { DatabaseSync } from 'node:sqlite'
import { createGraphReadFacet } from '@relay-harness/rlh-code-index-sqlite'
import { computeDirtyClosure } from './closure.ts'
import type { DirtyPropagationStatus } from './closure.ts'
import { catalogRowFromStored, reloadEdgesForFiles } from './reload-policy.ts'
import { computeExportFingerprint, exportFingerprintsChanged, reexportTargetsChanged } from './export-fingerprint.ts'
import { reresolveDirtyFiles } from '../store/resolved-writer.ts'
import type { SymbolResolver } from '../index.ts'

/** Default global promotion budget, matching the reference's `IndexingConfig`. */
export const DEFAULT_DIRTY_MAX_FILES = 200

/** Knobs of {@link runDirtyPropagation}. */
export interface DirtyPropagationConfig {
  /** Off short-circuits the whole phase into a `disabled` report. */
  readonly enabled: boolean
  /** GLOBAL promotion budget across all closure rounds. */
  readonly maxFiles: number
}

/** What one dirty-propagation phase observed, for the pass report. */
export interface DirtyPropagationReport {
  /** Files promoted to re-resolution (and actually re-resolved). */
  readonly marked: number
  /** The promoted paths, in promotion order; empty when nothing moved. */
  readonly promotedFiles: readonly string[]
  /** Importer-expansion rounds the closure ran. */
  readonly roundsRun: number
  /** True when the closure stopped early but kept a complete-round prefix. */
  readonly partial: boolean
  /** True when round-1 direct importers alone exceeded the budget. */
  readonly budgetExceeded: boolean
  /** Closure classification carried onto the pass report. */
  readonly status: DirtyPropagationStatus
}

/** Inputs of {@link runDirtyPropagation}. */
export interface RunDirtyPropagationInput {
  /** Admitted store handle carrying this build's committed delta. */
  readonly db: DatabaseSync
  /** Resolver over the live symbol catalog; re-resolves the promoted files. */
  readonly resolver: SymbolResolver
  /** Paths this build removed or renamed away; their importers must re-resolve. */
  readonly removedPaths: readonly string[]
  /** Paths this build freshly parsed and wrote; never promoted themselves. */
  readonly reparsedFiles: readonly string[]
  /**
   * Export fingerprints read BEFORE this build's write, per reparsed path;
   * absent keys and `null` values both mean the file had no stored
   * fingerprint. The post-write ledger already carries the new values, which
   * this phase reads back through the store's graph facet.
   */
  readonly previousFingerprints: ReadonlyMap<string, string | null>
  /** Knobs; defaults to enabled with {@link DEFAULT_DIRTY_MAX_FILES}. */
  readonly config?: Partial<DirtyPropagationConfig>
}

/** Disabled-phase report shared by every disabled short-circuit. */
function disabledReport(): DirtyPropagationReport {
  return { marked: 0, promotedFiles: [], roundsRun: 0, partial: false, budgetExceeded: false, status: 'disabled' }
}

/** Converged empty report. */
function normalReport(marked: number, roundsRun: number, promotedFiles: readonly string[]): DirtyPropagationReport {
  return { marked, promotedFiles, roundsRun, partial: false, budgetExceeded: false, status: 'normal' }
}

/**
 * Run the dirty-propagation phase over a freshly committed build.
 * @param input - store, resolver, this build's path sets, and the pre-write
 *   fingerprints; see {@link RunDirtyPropagationInput}.
 * @returns the promotion counts and closure classification.
 */
export function runDirtyPropagation(input: RunDirtyPropagationInput): DirtyPropagationReport {
  const config: DirtyPropagationConfig = { enabled: true, maxFiles: DEFAULT_DIRTY_MAX_FILES, ...input.config }
  if (!config.enabled) return disabledReport()

  const reparsedFiles = [...new Set(input.reparsedFiles)].sort()
  const removedPaths = [...new Set(input.removedPaths)].sort()
  if (reparsedFiles.length === 0 && removedPaths.length === 0) return normalReport(0, 0, [])

  const facet = createGraphReadFacet(input.db)
  const newFingerprints = new Map(
    facet.exportFingerprints(reparsedFiles).map(row => [row.filePath, row.fingerprint]),
  )
  const seeds = reparsedFiles
    .filter(filePath =>
      exportFingerprintsChanged(
        input.previousFingerprints.get(filePath) ?? null,
        newFingerprints.get(filePath) ?? null,
      ))
    .concat(removedPaths)
  if (seeds.length === 0) return normalReport(0, 0, [])

  const reparsedSet = new Set(reparsedFiles)
  const removedSet = new Set(removedPaths)
  // Resolved re-export targets memoize across rounds and re-evaluation passes
  // so each file's targets are read at most once; files without re-exports
  // cache an empty list.
  const reexportCache = new Map<string, readonly string[]>()

  const closure = computeDirtyClosure({
    seeds,
    maxFiles: config.maxFiles,
    findImportersOf: targets => facet.importerFilesForTargets(targets),
    isPromotable: path => !reparsedSet.has(path) && !removedSet.has(path),
    promotedExportSurfacesChanged: (files, changedSoFar) => {
      const missing = files.filter(path => !reexportCache.has(path))
      if (missing.length > 0) {
        const fetched = facet.reexportTargetsForFiles(missing)
        for (const path of missing) reexportCache.set(path, fetched.get(path) ?? [])
      }
      // Every candidate was cached by the loop above.
      return files.filter(path =>
        reexportTargetsChanged(reexportCache.get(path) as readonly string[], changedSoFar))
    },
  })

  const promoted = closure.promoted
  if (promoted.length > 0) {
    // The promoted files re-resolve against the current catalog: evict any
    // stale entries first, then load their committed rows so same-file
    // resolution sees the surviving symbols.
    const stale = promoted.filter(path => input.resolver.catalog.byFile.has(path))
    if (stale.length > 0) input.resolver.catalog.removeFiles(new Set(stale))
    const facetSymbols = facet.symbolsByFilePaths(promoted)
    if (facetSymbols.length > 0) input.resolver.catalog.addSymbols(facetSymbols.map(catalogRowFromStored))

    reresolveDirtyFiles(input.db, input.resolver, reloadEdgesForFiles(input.db, promoted))
  }

  return {
    marked: closure.marked,
    promotedFiles: promoted,
    roundsRun: closure.roundsRun,
    partial: closure.partial,
    budgetExceeded: closure.budgetExceeded,
    status: closure.status,
  }
}

/** Re-export the fingerprint computation so write paths hash with the same function the dirty phase compares against. */
export { computeExportFingerprint }
