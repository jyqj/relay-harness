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

/** Host-observed reasons a log-prefix confirmation cannot currently be submitted. */
export type WorkConfirmationBlocker = 'not-root' | 'turn-open' | 'running' | 'queued-input' | 'approval' | 'question' | 'background-job' | 'runtime-unavailable'

/** A captured review cut whose receipt is confirmed in durable storage. */
export interface WorkVerifiedReview extends WorkAcceptanceProjection {
  /** Advisory live eligibility; accept always rechecks the same policy under maintenance. */
  readonly confirmationBlockedBy: readonly WorkConfirmationBlocker[]
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
  /** Exact Session cut at which this path inventory was observed. */
  readonly sourceThroughSeq?: number
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly path: string
  readonly cwd?: string
}
/** Explicit coverage and continuation for one bounded Library scan. */
export interface WorkLibraryPage {
  /** Exact ids observed on this page, enabling deduplicated accumulated coverage. */
  readonly observedSessionIds?: readonly import('@relay-harness/rlh-session/types').SessionId[]
  /** Bounded retained observation, never a claim about every current device file. */
  readonly coverage?: { readonly scope: 'observed-corpus'; readonly snapshotId: WorkLibraryRevision; readonly omittedSessions: number }

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

/** Explicit passive address; unlike an Agent parameter this never invokes the live resolver. */
export interface WorkReadRequest { readonly sessionId: import('@relay-harness/rlh-session/types').SessionId }

/** One independently observed execution, not a second scheduler or authority graph. */
export interface WorkExecutionEntry {
  readonly id: string
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly parentSessionId?: import('@relay-harness/rlh-session/types').SessionId
  readonly kind: 'agent' | 'subagent' | 'job'
  readonly label: string
  readonly activity: 'running' | 'stopping' | 'idle' | 'inactive' | 'unknown'
  readonly outcome?: 'completed' | 'killed' | 'failed'
  readonly recovery: 'resident' | 'explicit-resume' | 'history-only' | 'unknown'
}

/** Application view joining independently owned facts; no aggregate mutable Work state exists. */
export interface WorkView {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly cwd?: string
  readonly parentSessionId?: import('@relay-harness/rlh-session/types').SessionId
  readonly relation: 'root' | 'fork' | 'delegated'
  readonly source: { readonly throughSeq: number; readonly resident: boolean; readonly current: boolean }
  readonly goal: { readonly id: string; readonly revision: number; readonly objective: string; readonly phase: string; readonly roundsStarted: number } | null
  readonly execution: { readonly activity: 'running' | 'idle' | 'unknown'; readonly entries: readonly WorkExecutionEntry[]; readonly omitted: number }
  readonly attention: { readonly approvals: number; readonly questions: number; readonly available: boolean }
  readonly outputs: DeliverablesProjection
  readonly review: WorkAcceptanceProjection
  readonly actions: { readonly confirmRecord: { readonly allowed: boolean; readonly blockers: readonly string[]; readonly scope: 'session-log' } }
  readonly capabilities: { readonly contextSources: readonly { readonly id: string; readonly purposes: readonly string[] }[]; readonly contextAvailable: boolean; readonly activationRequired: boolean }
  readonly coverage: { readonly missing: readonly string[]; readonly scope: 'observed-session-and-descendants' }
}

/** Bounded read of final human/assistant/tool messages; does not repair or activate execution. */
/** Revision-bound observation for paging; appends beyond throughSeq do not change it. */
export interface WorkHistorySnapshot {
  readonly throughSeq: number
  readonly digest: string
}
export interface WorkHistoryRequest extends WorkReadRequest {
  readonly snapshot?: WorkHistorySnapshot
  readonly beforeSeq?: number
  readonly limit?: number
}
/** One text-only historical observation with exact durable location. */
export interface WorkHistoryRow {
  readonly seq: number
  readonly kind: 'user' | 'assistant' | 'tool'
  readonly text: string
  readonly truncated: boolean
}
/** A captured read-only history page. Non-text and log-only events are not silently claimed as shown. */
export interface WorkHistoryPage {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly throughSeq: number
  readonly rows: readonly WorkHistoryRow[]
  readonly nextBeforeSeq: number | null
  readonly scope: 'text-messages-only'
  readonly snapshot: WorkHistorySnapshot
}
