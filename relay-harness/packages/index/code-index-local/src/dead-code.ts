/**
 * Pure answer assembly for the seam's `dead_code` explore op: symbols with no
 * incoming callers and no external references. Ported from the reference
 * implementation's dead-code pipeline (`handlers/graph.rs` + the read model's
 * `dead_code_candidates`): a bounded candidate scan, then in-memory phase-1
 * filters (empty identity, well-known entry-point names, test-ish prefixes)
 * and phase-2 external-reference elimination, with the reverse lookups
 * already folded into the facet's {@link AnalysisSymbolRow} rows.
 *
 * Contracts:
 * - The scan reads at most `min(40 × cap, 5000)` symbols — a bounded superset
 *   of the requested cap, mirroring the reference's adaptive scan budget.
 * - Every surviving candidate reports `reason: 'no-callers'`; external
 *   references (a referencing container that is missing or differs from the
 *   symbol's own name) eliminate the candidate the way the reference's
 *   phase-2 retention does.
 * - Rows with an empty uid or name never become candidates; entry-point
 *   names (`main`, `__init__`, `__main__`, `setup`, `configure`) and
 *   test-ish names (`test_*`, `Test*`) are excluded verbatim from the
 *   reference's exclusion lists.
 *
 * @module @relay-harness/rlh-code-index-local/dead-code
 */

import type { GraphDeadCodeView, GraphExploreRequest, GraphExploreResult } from '@relay-harness/rlh-code-index'
import type { AnalysisSymbolRow } from '@relay-harness/rlh-code-index-search'
import { TRUNCATED_RESULT_LIMIT } from './explore.ts'
import type { ExploreGraphInput } from './explore.ts'
import { finishAnswer } from './explore.ts'

/**
 * Declared edge kinds for the `dead_code` op: the reverse lookups that keep a
 * symbol alive (incoming call edges plus symbol references).
 */
export const DEAD_CODE_DECLARED: readonly string[] = ['CALLS', 'REFERENCES']

/**
 * Item cap when the request carries no `max` — the reference
 * implementation's `dead_code` output budget at its largest tier.
 */
export const DEFAULT_MAX_DEAD_CODE = 50

/** Multiplier on the requested item cap bounding the symbol scan. */
export const DEAD_CODE_SCAN_FACTOR = 40

/** Ceiling on the symbol scan so query cost stays bounded. */
export const DEAD_CODE_SCAN_MAX = 5000

/** Reason reported on every dead-code item. */
export const DEAD_CODE_REASON = 'no-callers'

/** Entry-point and bootstrap names the reference excludes from dead-code reporting. */
const EXCLUDED_NAMES: readonly string[] = ['main', '__init__', '__main__', 'setup', 'configure']

/** Name prefixes the reference excludes from dead-code reporting. */
const EXCLUDED_PREFIXES: readonly string[] = ['test_', 'Test']

/**
 * Adaptive scan budget for a requested item cap: `cap × 40`, capped at 5000 —
 * the reference's `dead_code_scan_limit` formula, locked by its tests.
 * @param itemCap - the effective dead-code item cap.
 * @returns the symbol-scan limit.
 */
export function deadCodeScanLimit(itemCap: number): number {
  return Math.min(itemCap * DEAD_CODE_SCAN_FACTOR, DEAD_CODE_SCAN_MAX)
}

/** Phase-1 identity/exclusion filters plus the no-caller and no-external-ref lookups. */
function isCandidate(row: AnalysisSymbolRow): boolean {
  if (row.symbolUid === '' || row.name === '') return false
  if (EXCLUDED_NAMES.includes(row.name)) return false
  if (EXCLUDED_PREFIXES.some(prefix => row.name.startsWith(prefix))) return false
  return !row.hasCaller && !row.hasExternalRef
}

/**
 * Answer the `dead_code` op: candidates from a bounded scan, cut to the
 * requested cap after the filters run.
 * @param input - the question, facet, tier limits, tier, and epochs.
 * @param request - the `dead_code` request carrying its optional cap.
 * @returns the complete answer; `candidateCount` counts the candidates that
 *   SURVIVED the phase-1/phase-2 filters (the scan's raw row count is never
 *   exposed), and `truncated` rides with `result_limit` when the cap cut that
 *   filtered list.
 */
export function deadCodeAnswer(
  input: ExploreGraphInput,
  request: Extract<GraphExploreRequest, { op: 'dead_code' }>,
): GraphExploreResult {
  const cap = request.max ?? DEFAULT_MAX_DEAD_CODE
  const scanLimit = deadCodeScanLimit(cap)
  const candidates: GraphDeadCodeView[] = input.facet.analysisSymbolRows(scanLimit)
    .filter(isCandidate)
    .map(row => ({
      symbolName: row.name,
      symbolId: row.symbolUid,
      filePath: row.filePath,
      kind: row.kind,
      reason: DEAD_CODE_REASON,
    }))
  const items = candidates.slice(0, cap)
  const truncatedReason = candidates.length > items.length ? TRUNCATED_RESULT_LIMIT : undefined
  return {
    ...finishAnswer(input, 'dead_code', DEAD_CODE_DECLARED, [], [], undefined, [], truncatedReason, candidates.length),
    deadCode: items,
  }
}
