/**
 * rlh-context-engine's owned branded ids: {@link SourceId} and {@link EvidenceId}, the opaque
 * identities used by the evidence protocol. The `Branded<B>` primitive lives in
 * `@relay-harness/rlh-brand`; keeping each type and its factory together here lets `index.ts`
 * re-export both under one name.
 * @module @relay-harness/rlh-context-engine/brand
 */

import type { Branded } from '@relay-harness/rlh-brand'

/** Opaque identity of one registered local source (file tree, session corpus, memory scope). */
export type SourceId = Branded<'SourceId'>

/**
 * Brand a string as a {@link SourceId}. No validation — source registration rejects an empty id.
 * @param id - the source's stable identifier.
 * @returns the same string, branded.
 */
export function SourceId(id: string): SourceId {
  return id as SourceId
}

/** Opaque identity of one admitted evidence record within a prepared step context. */
export type EvidenceId = Branded<'EvidenceId'>

/**
 * Brand a string as an {@link EvidenceId}. Contributors mint ids unique within one
 * `prepareStep` result.
 * @param id - the evidence record's identifier.
 * @returns the same string, branded.
 */
export function EvidenceId(id: string): EvidenceId {
  return id as EvidenceId
}
