/**
 * Structured failure codes for the retrieval-domain search engine.
 *
 * @module @relay-harness/rlh-code-index-search/errors
 */

import { HarnessError } from '@relay-harness/rlh-llm'

/** The search request could not be planned (invalid query shape or scope). */
export const SEARCH_REQUEST_INVALID = 'SEARCH_REQUEST_INVALID'

/** A registry assembly rejected the lane/preselect layer set passed to the engine. */
export const SEARCH_REGISTRY_INVALID = 'SEARCH_REGISTRY_INVALID'

/** The store port rejected the tier-resolution read (`countFiles`); no result can be computed. */
export const SEARCH_PORT_READ_FAILED = 'SEARCH_PORT_READ_FAILED'

/**
 * Structured code-index-search failure. Extends {@link HarnessError} with a
 * stable `code` (`SEARCH_*`) that consumers route on instead of parsing
 * `message`. Lane-level read failures do NOT use this class: they degrade the
 * result into `readErrors` + `degraded` instead.
 */
export class SearchEngineError extends HarnessError {}
