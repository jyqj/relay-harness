/**
 * Export-surface fingerprinting for incremental dirty propagation.
 *
 * Ported from the reference implementation's `IndexDb::get_export_fingerprint`
 * (SQL side) and `Indexer::compute_fingerprint_for_unit` (in-memory side),
 * which are locked to byte-identical output by contract tests. This module is
 * the single in-memory implementation: the write path persists its result
 * under `export_fingerprint:<filePath>` in the store's metadata ledger, and
 * the dirty phase compares the freshly computed value against the stored one,
 * so a build only seeds its closure from files whose public API surface
 * actually moved.
 *
 * @module @relay-harness/rlh-code-index-graph/dirty/export-fingerprint
 */

import { createHash } from 'node:crypto'

/**
 * Minimal symbol projection the fingerprint reads. Both parse outcomes
 * (`SymbolRecord`) and store rows (`SymbolRowInput`) satisfy this
 * structurally, so callers hash whichever vocabulary they hold.
 */
export interface ExportSurfaceSymbol {
  /** Declared short name. */
  readonly name: string
  /** Declared signature text, or `null`. */
  readonly signature: string | null
  /** Exported name when the declaration is exported, else `null`. */
  readonly exportName: string | null
  /** True for `export default <name>` with no explicit export name. */
  readonly isDefaultExport: boolean
  /** Semantic symbol uid, or `null` when the producer could not derive one. */
  readonly symbolUid: string | null
}

/**
 * Compute one file's export fingerprint from its symbols.
 *
 * Exported symbols (`exportName` set, or the file's default export) render as
 * `{uid}|{name}|{signature}|{exportName}` lines; the whole-line sort matches
 * the store-side `ORDER BY symbol_uid` because the uid is each line's first
 * field. No exports yields `null` — the same answer the ledger gives for a
 * file with no stored fingerprint, so a file gaining or losing its entire
 * export surface always compares as changed.
 * @param symbols - every symbol the file declares.
 * @returns the 64-hex-character SHA-256 digest, or `null` with no exports.
 */
export function computeExportFingerprint(symbols: readonly ExportSurfaceSymbol[]): string | null {
  const parts = symbols
    .filter(symbol => symbol.exportName !== null || symbol.isDefaultExport)
    .map(symbol => `${symbol.symbolUid ?? ''}|${symbol.name}|${symbol.signature ?? ''}|${symbol.exportName ?? ''}`)
    .sort()
  if (parts.length === 0) return null
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')
}

/**
 * Compare a file's previous and current export fingerprints.
 * @param previous - fingerprint stored before this build, `null` when absent.
 * @param current - fingerprint computed from the fresh parse, `null` with no exports.
 * @returns whether the file's export surface changed.
 */
export function exportFingerprintsChanged(previous: string | null, current: string | null): boolean {
  return previous !== current
}

/**
 * Whether any of a file's resolved re-export targets sits in the changed set
 * (the reference's `reexport targets ∩ changed_so_far` check). A promoted
 * file whose re-exported surface moved must surface that change to its own
 * importers, which is what drives the closure's next frontier.
 * @param targets - resolved paths the file re-exports from.
 * @param changedSoFar - every file whose export surface changed so far.
 * @returns whether the file's effective export surface changed.
 */
export function reexportTargetsChanged(targets: readonly string[], changedSoFar: ReadonlySet<string>): boolean {
  return targets.some(target => changedSoFar.has(target))
}
