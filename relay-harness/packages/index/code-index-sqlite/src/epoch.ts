/**
 * Epoch clocks over the derived SQLite store.
 *
 * Ported from the reference implementation's declared epoch rules
 * (`cc-db/src/epoch_rules.rs`): every committed content-bearing write
 * transaction advances `index_epoch` exactly once, inside the same
 * transaction as its writes, and `evidence_epoch` stays frozen until
 * evidence ingestion lands. Cache slots above the seam key on the observed clock snapshot (see
 * {@link ./cache.ts!ChunkTextCache | ChunkTextCache}), so a missed bump leaks
 * stale results and a spurious bump destroys cache locality.
 *
 * @module @relay-harness/rlh-code-index-sqlite/epoch
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  CodeIndexError,
  CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
  type EpochPair,
} from '@relay-harness/rlh-code-index'
import {
  CODE_INDEX_METADATA_EMBEDDING_EPOCH,
  CODE_INDEX_METADATA_EVIDENCE_EPOCH,
  CODE_INDEX_METADATA_INDEX_EPOCH,
} from './ddl.ts'

/** Which persisted clock a write transaction declares it bumps. */
export type EpochChannel = 'index' | 'evidence' | 'embedding'

/**
 * Read the persisted epoch pair out of the metadata ledger.
 *
 * The rows are seeded at `'0'` by schema creation, so this fails loud only on
 * a ledger that lost or was hand-edited outside this store: an unrecognized
 * derived medium must never be silently re-zeroed, because consumers would
 * keep serving stale cache entries keyed on the rewound clock.
 * @param db - admitted handle with the schema present.
 * @returns the current `(indexEpoch, evidenceEpoch)` pair.
 * @throws {CodeIndexError} with `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED` when a
 *   seeded metadata row is missing or carries a non-integer counter.
 */
export function readEpochs(db: DatabaseSync): EpochPair {
  const rows = db.prepare(
    'SELECT key, value FROM metadata WHERE key IN (?, ?, ?)',
  ).all(
    CODE_INDEX_METADATA_INDEX_EPOCH,
    CODE_INDEX_METADATA_EVIDENCE_EPOCH,
    CODE_INDEX_METADATA_EMBEDDING_EPOCH,
  ) as Array<{ key: string; value: string }>
  const values = new Map(rows.map(row => [row.key, row.value]))
  return {
    indexEpoch: parseEpochCounter(values.get(CODE_INDEX_METADATA_INDEX_EPOCH), CODE_INDEX_METADATA_INDEX_EPOCH),
    evidenceEpoch: parseEpochCounter(values.get(CODE_INDEX_METADATA_EVIDENCE_EPOCH), CODE_INDEX_METADATA_EVIDENCE_EPOCH),
    embeddingEpoch: parseEpochCounter(values.get(CODE_INDEX_METADATA_EMBEDDING_EPOCH), CODE_INDEX_METADATA_EMBEDDING_EPOCH),
  }
}

/** Parse one persisted counter, refusing anything but a non-negative integer string. */
function parseEpochCounter(raw: string | undefined, key: string): number {
  if (raw === undefined || raw === '') {
    throw new CodeIndexError(
      `code-index metadata is missing its seeded "${key}" row`,
      CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
    )
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CodeIndexError(
      `code-index metadata "${key}" carries an unparsable counter ${JSON.stringify(raw)}`,
      CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
    )
  }
  return parsed
}

/**
 * Run one write unit with an exactly-once index-epoch bump folded into its
 * transaction. The whole unit opens under `BEGIN IMMEDIATE`, `fn` performs
 * every write statement inside it, the counter advances as the last statement
 * before COMMIT, and any failure rolls the unit back to the pre-call state —
 * including the counter, so failed batches leave no epoch residue.
 *
 * The evidence channel stays untouched here by declaration: these writes are
 * all index content (`epoch_rules.rs`); evidence ingestion bumps the sibling
 * clock through {@link bumpEvidenceEpochOnceInTx}.
 * @param db - admitted handle; no other transaction may be open on it.
 * @param fn - callback performing the unit's write statements against `db`.
 * @returns whatever `fn` returned, only after the COMMIT succeeded.
 */
export function bumpIndexEpochOnceInTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    advanceIndexEpoch(db)
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Persist `index_epoch + 1`; called only between BEGIN IMMEDIATE and COMMIT. */
function advanceIndexEpoch(db: DatabaseSync): void {
  db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(
    String(readEpochs(db).indexEpoch + 1),
    CODE_INDEX_METADATA_INDEX_EPOCH,
  )
}

/**
 * Run one write unit with an exactly-once evidence-epoch bump folded into its
 * transaction, mirroring {@link bumpIndexEpochOnceInTx} on the sibling clock:
 * `BEGIN IMMEDIATE`, `fn` performs every write, the counter advances as the
 * last statement before COMMIT, and any failure rolls the whole unit —
 * counter included — back.
 *
 * This is the reserved runtime-evidence channel's writer. No current provider
 * calls it: vector materialization uses {@link bumpEmbeddingEpochOnceInTx},
 * so exposing the clock does not falsely claim runtime evidence support.
 * @param db - admitted handle; no other transaction may be open on it.
 * @param fn - callback performing the unit's write statements against `db`.
 * @returns whatever `fn` returned, only after the COMMIT succeeded.
 */
export function bumpEvidenceEpochOnceInTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    advanceEvidenceEpoch(db)
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Commit one vector-materialization batch and advance only `embedding_epoch`.
 * @param db - admitted handle with no open transaction.
 * @param fn - vector write unit executed inside the transaction.
 * @returns callback result after the commit succeeds.
 */
export function bumpEmbeddingEpochOnceInTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    advanceEmbeddingEpoch(db)
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Persist `evidence_epoch + 1`; called only between BEGIN IMMEDIATE and COMMIT. */
function advanceEvidenceEpoch(db: DatabaseSync): void {
  db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(
    String(readEpochs(db).evidenceEpoch + 1),
    CODE_INDEX_METADATA_EVIDENCE_EPOCH,
  )
}

function advanceEmbeddingEpoch(db: DatabaseSync): void {
  db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(
    String((readEpochs(db).embeddingEpoch ?? 0) + 1),
    CODE_INDEX_METADATA_EMBEDDING_EPOCH,
  )
}

/**
 * Audit helper mirroring the reference implementation's declared-clock audit:
 * a committed write in the named channel must have advanced that channel's
 * counter exactly once while leaving the sibling counter frozen. Callers read
 * the pair before and after a commit and route any mismatch into loud failure —
 * the storage layer's own writer folds the bump into its transactions, so a
 * violation means the declared rule and the observed commit disagree.
 * @param before - pair read before the audited commit.
 * @param after - pair read after the audited commit.
 * @param channel - which clock the commit declares it advances.
 * @throws {CodeIndexError} with `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED` when
 *   the declared clock did not advance exactly once or the frozen clock moved.
 */
export function assertExactAdvance(before: EpochPair, after: EpochPair, channel: EpochChannel): void {
  const advancing = channel === 'index' ? 'indexEpoch' : channel === 'evidence' ? 'evidenceEpoch' : 'embeddingEpoch'
  const beforeAdvancing = before[advancing] ?? 0
  const afterAdvancing = after[advancing] ?? 0
  if (afterAdvancing !== beforeAdvancing + 1) {
    throw new CodeIndexError(
      `declared ${channel} write did not advance the ${advancing} counter exactly once `
        + `(${beforeAdvancing} -> ${afterAdvancing})`,
      CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
    )
  }
  for (const frozen of ['indexEpoch', 'evidenceEpoch', 'embeddingEpoch'] as const) {
    if (frozen === advancing) continue
    if ((after[frozen] ?? 0) !== (before[frozen] ?? 0)) {
      throw new CodeIndexError(
        `declared ${channel} write moved the frozen ${frozen} counter (${before[frozen] ?? 0} -> ${after[frozen] ?? 0})`,
        CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
      )
    }
  }
}
