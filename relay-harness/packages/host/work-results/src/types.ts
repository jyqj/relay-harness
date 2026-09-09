import type { Branded } from '@relay-harness/rlh-brand'
/** Whole-session inventory of execution-recorded, tool-declared file mutations. */
export interface DeliverablesProjection {
  /** Unique declared paths in first successful execution order. */
  readonly paths: readonly string[]
  /** Successful root results without execution-time capture; the historical inventory is incomplete. */
  readonly unindexedResults: number
}

declare module '@relay-harness/rlh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable whole-log file inventory, independent of client history windows. */
    deliverables: DeliverablesProjection
  }
}

/** Projection of a user's acceptance against an exact Session log prefix. */
export interface WorkAcceptanceProjection {
  /** Last non-acceptance event; -1 means no reviewable log. */
  readonly reviewRevision: number
  /** Whether the latest turn boundary is terminal rather than open. */
  readonly reviewable: boolean
  /** Last explicitly accepted revision; null means no user acceptance. */
  readonly acceptedRevision: number | null
}

/** A captured review cut whose receipt is confirmed in durable storage. */
export interface WorkVerifiedReview extends WorkAcceptanceProjection {
  /** Durable cut verified by the Host; -1 when there is no receipt to verify. */
  readonly verifiedThroughSeq: number
  /** False when later live log facts superseded the captured cut during verification. */
  readonly current: boolean
}

/** Explicit acceptance request; caller identity is established by the Host carrier. */
export interface WorkAcceptRequest { readonly reviewRevision: number }
/** Durable acceptance receipt, without changing goal or execution state. */
export interface WorkAcceptReceipt {
  readonly reviewedThroughSeq: number
  readonly recordedSeq: number
  /** Whether the reviewed prefix is still current after its durability barrier. */
  readonly current: boolean
}
/** Opaque identity of the ordered Session corpus and normalized query. */
export type WorkLibraryRevision = Branded<'work-library-revision'>

/** Bounded scan request over existing Session logs. */
export interface WorkLibraryRequest {
  readonly query?: string
  readonly corpusRevision?: WorkLibraryRevision
  readonly sessionOffset?: number
  readonly pathOffset?: number
  readonly limit?: number
}
/** One output and its authoritative source Session. */
export interface WorkLibraryEntry {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly path: string
  readonly cwd?: string
}
/** Explicit coverage and continuation for one bounded Library scan. */
export interface WorkLibraryPage {
  readonly entries: readonly WorkLibraryEntry[]
  readonly scannedSessions: number
  readonly totalSessions: number
  readonly unindexedResults: number
  readonly unavailableSessions: number
  readonly next: { readonly sessionOffset: number; readonly pathOffset: number; readonly corpusRevision: WorkLibraryRevision } | null
}
/** Exact output to open; paths must belong to the addressed source log. */
export interface WorkOpenRequest {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly path: string
}

declare module '@relay-harness/rlh-session/types' {
  interface SessionEventMap {
    /** User acceptance of an exact prior log prefix, never model verification. */
    'work/accepted': { readonly reviewedThroughSeq: number; readonly actor: 'host-client' }
  }
}
declare module '@relay-harness/rlh-session-projection/types' {
  interface SessionProjectionMap {
    /** User acceptance derived only from the source Session log. */
    workAcceptance: WorkAcceptanceProjection
  }
}
