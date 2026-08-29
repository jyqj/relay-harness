/**
 * Structured failure codes for the local code-index capability.
 *
 * @module @relay-harness/rlh-code-index/errors
 */

import { HarnessError } from '@relay-harness/rlh-llm'

/** The database file at the configured path belongs to another application. */
export const CODE_INDEX_DB_FOREIGN_APPLICATION = 'CODE_INDEX_DB_FOREIGN_APPLICATION'

/** The database carries an unsupported schema version and rebuild-on-mismatch could not run. */
export const CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED = 'CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED'

/** A search was attempted before the workspace had been indexed at least once. */
export const CODE_INDEX_NOT_INDEXED = 'CODE_INDEX_NOT_INDEXED'

/** A chunk-vector row violates its storage contract (the byte view contradicts `dim`). */
export const CODE_INDEX_VECTOR_ROW_INVALID = 'CODE_INDEX_VECTOR_ROW_INVALID'

/**
 * Structured code-index failure. Extends {@link HarnessError} with a stable `code`
 * (`CODE_INDEX_*`) that consumers route on instead of parsing `message`.
 */
export class CodeIndexError extends HarnessError {}
