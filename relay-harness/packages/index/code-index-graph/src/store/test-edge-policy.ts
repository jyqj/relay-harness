/**
 * Test-edge rebuild decision and dispatch for the index write orchestration.
 *
 * The storage layer exposes rebuild primitives only; WHICH rebuild a batch
 * needs is orchestration, decided here with the reference implementation's
 * `postprocess.rs` inputs: test edges are path-derived, so a batch whose path
 * set did not change (pure content updates) leaves the committed edges already
 * exact, while a changed path set rebuilds — per changed path when the caller
 * can enumerate it, whole-table when it cannot.
 *
 * @module @relay-harness/rlh-code-index-graph/store/test-edge-policy
 */

import type { DatabaseSync } from 'node:sqlite'
import type { RebuildTestEdgesResult } from '@relay-harness/rlh-code-index-sqlite'
import { rebuildTestEdgesForFiles, rebuildTestEdgesFull } from '@relay-harness/rlh-code-index-sqlite'

/** Which test-edge rebuild a batch needs. */
export type TestEdgeRebuildDecision = 'full' | 'files' | 'skip'

/** Inputs of {@link decideTestEdgeRebuild}. */
export interface TestEdgeRebuildInput {
  /**
   * True when this batch removed or renamed paths away, so the stored path
   * set changed and the committed test edges may no longer be exact.
   */
  readonly hadRemovalsOrRenames: boolean
  /**
   * Workspace-relative paths written or removed by this batch, or `undefined`
   * when the caller cannot enumerate them (e.g. a full rebuild).
   */
  readonly changedPaths: readonly string[] | undefined
}

/**
 * Decide which test-edge rebuild a batch needs, mirroring the reference's
 * `postprocess.rs` gate: a full or unenumerable changed set rebuilds the whole
 * table, a changed path set with known paths rebuilds per path, and a batch
 * that only rewrote file contents (no removals, no renames, no new paths)
 * skips outright — the per-path endpoint deletes of an earlier pass are the
 * only way edges disappear, and none ran.
 * @param input - whether the path set changed and which paths are known.
 * @returns the rebuild decision for {@link applyTestEdgeRebuild}.
 */
export function decideTestEdgeRebuild(input: TestEdgeRebuildInput): TestEdgeRebuildDecision {
  if (!input.hadRemovalsOrRenames) return 'skip'
  if (input.changedPaths === undefined) return 'full'
  if (input.changedPaths.length === 0) return 'skip'
  return 'files'
}

/**
 * Run the decided test-edge rebuild against the store.
 * @param db - admitted handle; must not have another transaction open.
 * @param decision - decision from {@link decideTestEdgeRebuild}.
 * @param changedPaths - the batch's changed paths; required for `'files'` and
 *   ignored for the other decisions.
 * @returns the committed rebuild's write counts; `'skip'` reports zero rows
 *   without opening a transaction, so the index epoch never moves.
 * @throws When `decision` is `'files'` but `changedPaths` is `undefined` — a
 *   caller contract violation fails loud instead of silently rebuilding
 *   nothing.
 */
export function applyTestEdgeRebuild(
  db: DatabaseSync,
  decision: TestEdgeRebuildDecision,
  changedPaths: readonly string[] | undefined,
): RebuildTestEdgesResult {
  if (decision === 'skip') return { edgesWritten: 0 }
  if (decision === 'full') return rebuildTestEdgesFull(db)
  if (changedPaths === undefined) {
    throw new Error('test-edge rebuild decision "files" requires the batch changedPaths')
  }
  return rebuildTestEdgesForFiles(db, changedPaths)
}
