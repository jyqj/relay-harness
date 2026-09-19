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
    /** Explicit user content review bound to versions and check records, never to a log prefix. */
    'work/reviewed': WorkContentReview
  }
}
declare module '@relay-harness/rlh-session-projection/types' {
  interface SessionProjectionMap {
    /** User acceptance derived only from the source Session log. */
    workAcceptance: WorkAcceptanceProjection
    /** Latest explicit content review derived only from the source Session log. */
    workContentReviews: WorkContentReviewsProjection
  }
}

/** Explicit passive address; unlike an Agent parameter this never invokes the live resolver. */
export interface WorkReadRequest { readonly sessionId: import('@relay-harness/rlh-session/types').SessionId }

/**
 * How one execution relates to the addressed Work, read from durable session
 * headers and the existing subagent catalog. An edge on this graph is
 * descriptive only: {@link WorkExecutionRelationship.controlLink} carries the
 * separate control observation, so a related execution never implies a control
 * right over it.
 */
export type WorkRelationshipKind =
  /** The Work's own root execution, or an in-process Job it started. */
  | 'owned'
  /** A session-backed subagent this Work (or the entry's direct parent) delegated for one terminal result. */
  | 'delegated'
  /** A session-backed continuable child holding a durable report channel back to its direct parent. */
  | 'reports-to'
  /** The Work's root Session itself was forked from a parent Session. */
  | 'forked-from'

/** Observed relationship edge of one execution toward the addressed Work. */
export interface WorkExecutionRelationship {
  readonly kind: WorkRelationshipKind
  /** Counterparty Session of the edge; absent when the edge names no peer. */
  readonly peerSessionId?: import('@relay-harness/rlh-session/types').SessionId
  /**
   * True only while the Host registry holds this exact execution live. Graph
   * adjacency, a durable parent header, and a continuable descriptor never set
   * it; only present residency does.
   */
  readonly controlLink: boolean
}

/**
 * What recovery can honestly promise for one execution, derived only from
 * observed state. Absent evidence stays `unknown`; nothing here is ever
 * upgraded to a resume claim without evidence.
 */
export interface WorkExecutionRecovery {
  /**
   * Where the execution's recorded history lives: `persisted` in durable
   * Session storage, `in-process` in the live Host process only, `unknown`
   * without evidence.
   */
  readonly history: 'persisted' | 'in-process' | 'unknown'
  /** Whether an explicit resume path exists; `unavailable` when none can exist, `unknown` without evidence. */
  readonly resume: 'explicit' | 'unavailable' | 'unknown'
  /** Whether the Host currently controls this execution in-process. */
  readonly control: 'resident' | 'none'
}

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
  /** Relationship edge toward the addressed Work; absent on partial observations. */
  readonly relationship?: WorkExecutionRelationship
  /** Detailed recovery promises; `recovery` stays the compact summary for existing consumers. */
  readonly recoveryCapabilities?: WorkExecutionRecovery
}

/** Application view joining independently owned facts; no aggregate mutable Work state exists. */
export interface WorkView {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly cwd?: string
  readonly parentSessionId?: import('@relay-harness/rlh-session/types').SessionId
  readonly relation: 'root' | 'fork' | 'delegated'
  readonly source: { readonly throughSeq: number; readonly resident: boolean; readonly current: boolean }
  readonly goal: {
    readonly id: string
    readonly revision: number
    readonly objective: string
    readonly phase: string
    readonly roundsStarted: number
  } | null
  readonly execution: { readonly activity: 'running' | 'idle' | 'unknown'; readonly entries: readonly WorkExecutionEntry[]; readonly omitted: number }
  readonly attention: { readonly approvals: number; readonly questions: number; readonly available: boolean }
  readonly outputs: DeliverablesProjection
  readonly review: WorkAcceptanceProjection
  readonly actions: { readonly confirmRecord: { readonly allowed: boolean; readonly blockers: readonly string[]; readonly scope: 'session-log' } }
  readonly capabilities: {
    readonly contextSources: readonly { readonly id: string; readonly purposes: readonly string[] }[]
    readonly contextAvailable: boolean
    readonly activationRequired: boolean
  }
  readonly coverage: { readonly missing: readonly string[]; readonly scope: 'observed-session-and-descendants' }
}

/** Observed content identity of one execution environment at one log cut. */
export interface WorkContentExecution {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly cwd?: string
}

/** Authoritative Session cut anchoring one content observation. */
export interface WorkContentSource {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  /** Event sequence the bytes were read at. */
  readonly throughSeq: number
}

/** What was actually read: environment, source, locator, hash and observation time. */
export interface WorkContentVersion {
  readonly execution: WorkContentExecution
  readonly source: WorkContentSource
  /** Execution-recorded locator the bytes were read from. */
  readonly locator: string
  readonly contentHash: { readonly algorithm: 'sha256'; readonly digest: string }
  /** Non-negative epoch milliseconds when the bytes were read. */
  readonly observedAt: number
}

/** How one check record's facts were established; capture strength rises left to right. */
export type WorkCheckEvidence = 'agent-claimed' | 'host-captured' | 'user-reviewed'

/** Opaque identity of one check record inside its owning review. */
export type WorkCheckId = Branded<'work-check-record'>

/** One checker execution attached to a content review; facts, not success claims. */
export interface WorkCheckRecord {
  readonly checkId: WorkCheckId
  readonly checker: { readonly name: string; readonly version?: string; readonly configDigest?: string }
  /** Content-version digests consumed; each must resolve in the owning review. */
  readonly contentVersionRefs: readonly string[]
  readonly exitCode?: number
  readonly verdict: 'pass' | 'fail' | 'unknown'
  /** Durable location of the checker's own output, when captured. */
  readonly log?: { readonly sessionId: import('@relay-harness/rlh-session/types').SessionId; readonly seq: number }
  readonly evidence: WorkCheckEvidence
}

/** The user decision a content review records. */
export type WorkContentDecision = 'approved' | 'rejected'

/** Opaque identity of one recorded content review. */
export type WorkContentReviewId = Branded<'work-content-review'>

/** A user decision bound to explicit content versions and check records — never to a log prefix. */
export interface WorkContentReview {
  readonly reviewId: WorkContentReviewId
  readonly decision: WorkContentDecision
  /** All observed versions this review carries. */
  readonly contentVersions: readonly WorkContentVersion[]
  /** Version digests the decision applies to; each must resolve in `contentVersions`. */
  readonly contentVersionRefs: readonly string[]
  readonly checkRecords: readonly WorkCheckRecord[]
  /** Check ids the decision relies on; each must resolve in `checkRecords`. */
  readonly checkRecordRefs: readonly string[]
  readonly actor: 'host-client'
  /** Non-negative epoch milliseconds when the Host recorded the review. */
  readonly reviewedAt: number
}

/** Honest confirmed-vs-current state of one confirmed version. */
export type WorkContentCurrency =
  | { readonly ref: string; readonly state: 'matches-confirmed' }
  | { readonly ref: string; readonly state: 'changed-unreviewed'; readonly current: WorkContentVersion }
  | { readonly ref: string; readonly state: 'not-reverified' }

/** Latest durable content review plus its read-side confirmed-vs-current comparison. */
export interface WorkContentReviewRead {
  readonly review: WorkContentReview | null
  readonly currency: readonly WorkContentCurrency[]
}

/** Durable whole-log fold of explicit content reviews. */
export interface WorkContentReviewsProjection {
  /** Most recent content review, or null before the first one. */
  readonly latest: WorkContentReview | null
  /** Number of recorded content reviews. */
  readonly total: number
}

/** Explicit content review submission; caller identity is established by the Host carrier. */
export interface WorkContentReviewRequest {
  readonly decision: WorkContentDecision
  readonly contentVersions: readonly WorkContentVersion[]
  readonly contentVersionRefs: readonly string[]
  readonly checkRecords: readonly WorkCheckRecord[]
  readonly checkRecordRefs: readonly string[]
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
