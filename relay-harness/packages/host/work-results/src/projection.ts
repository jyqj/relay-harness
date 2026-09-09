/** Pure whole-log fold of execution-captured file mutations. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@relay-harness/rlh-session-projection'
import type { DeliverablesProjection } from './types.ts'

/** Projection unit consumed by every existing session-projection carrier. */
export const deliverablesProjection: ProjectionDefinition<'deliverables', DeliverablesProjection> = {
  key: 'deliverables',
  stateVersion: 1,
  schema: z.object({ paths: z.array(z.string()), unindexedResults: z.number().int().nonnegative() }).strict(),
  init: () => ({ paths: [], unindexedResults: 0 }),
  apply: (state, event) => {
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.data.message.content[0].isError === true) return state
    const captured = event.data.producedFiles
    if (captured === undefined) return { ...state, unindexedResults: state.unindexedResults + 1 }
    const paths = [...new Set([...state.paths, ...captured])]
    return paths.length === state.paths.length ? state : { ...state, paths }
  },
  view: state => state,
}

const acceptedData = z.object({ reviewedThroughSeq: z.number().int().nonnegative(), actor: z.literal('host-client') }).strict()

/**
 * Decode a receipt read from a durable or live source event.
 * @param data - serialized event data at the log boundary.
 * @returns the validated reviewed prefix sequence.
 */
export function readAcceptedRevision(data: unknown): number { return acceptedData.parse(data).reviewedThroughSeq }

/** Whole-log revision and explicit-user acceptance; a receipt does not invalidate itself. */
export const workAcceptanceProjection: ProjectionDefinition<'workAcceptance', import('./types.ts').WorkAcceptanceProjection> = {
  key: 'workAcceptance',
  stateVersion: 1,
  schema: z.object({
    reviewRevision: z.number().int().min(-1), acceptedRevision: z.number().int().nonnegative().nullable(), reviewable: z.boolean(),
  }).strict(),
  init: () => ({ reviewRevision: -1, acceptedRevision: null, reviewable: false }),
  apply: (state, event) => {
    if (event.type !== 'work/accepted') return { ...state, reviewRevision: event.seq, reviewable: event.type === 'turn/end' ? true : event.type === 'turn/start' ? false : state.reviewable }
    const revision = readAcceptedRevision(event.data)
    if (revision !== state.reviewRevision || revision >= event.seq) throw new Error('workResults receipt does not match its prior review revision')
    return { ...state, acceptedRevision: revision }
  },
  view: state => state,
}
