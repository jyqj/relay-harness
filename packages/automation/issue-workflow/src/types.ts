/** Repository-owned issue automation policy shared by schedulers and file providers. */

/** Typed policy resolved from one workflow document revision. */
export interface IssueWorkflowPolicy {
  readonly trackerProvider: string
  readonly activeStates: readonly string[]
  readonly terminalStates: readonly string[]
  readonly requiredLabels: readonly string[]
  readonly pollIntervalMs: number
  readonly maxConcurrentRuns: number
  readonly maxConcurrentRunsByState: Readonly<Record<string, number>>
  readonly maxTurns: number
  readonly continuationRetryMs: number
  /** Maximum continuation redispatches after the first attempt for one still-eligible issue; 0 disables the bound. */
  readonly maxContinuationAttempts: number
  readonly failureRetryBaseMs: number
  readonly maxRetryBackoffMs: number
  readonly stallTimeoutMs: number
  readonly promptTemplate: string
  readonly continuationTemplate: string
}

/** Immutable last-known-good workflow revision. */
export interface IssueWorkflowSnapshot {
  readonly path: string
  readonly revision: string
  readonly loadedAt: number
  readonly policy: IssueWorkflowPolicy
}
