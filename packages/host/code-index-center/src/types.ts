/** Client-safe Code Index Center Remote vocabulary. */
/** Monotonic generation clocks shown by the Center. */
export interface CodeIndexEpochs {
  readonly indexEpoch: number
  readonly evidenceEpoch: number
  readonly embeddingEpoch?: number
}
/** Bounded explanation of the latest build lifecycle. */
export interface CodeIndexBuildExplain {
  readonly scope: 'full' | 'scoped'
  readonly requestedPaths: number
  readonly pass: 'ran' | 'skipped'
  readonly degraded: boolean
  readonly degradationReasons: readonly string[]
  readonly dirty: {
    readonly status: string
    readonly marked: number
    readonly roundsRun: number
    readonly partial: boolean
    readonly budgetExceeded: boolean
  } | null
  readonly embedding: {
    readonly generationId: string
    readonly missingChunks: number
    readonly jobsEnqueued: number
    readonly jobsDeduplicated: number
    readonly jobsReset: number
    readonly batchesClaimed: number
    readonly batchesWritten: number
    readonly jobsCompleted: number
    readonly jobsFailed: number
  } | null
}
/** Latest refresh summary carried in management status. */
export interface CodeIndexRefreshView {
  readonly reason: string
  readonly changedFiles: number
  readonly removedFiles: number
  readonly chunksWritten: number
  readonly durationMs: number
  readonly epochsAfter: CodeIndexEpochs
  readonly explain?: CodeIndexBuildExplain
}
/** One embedding generation and its coverage/backlog. */
export interface CodeIndexGenerationView {
  readonly generationId: string
  readonly providerId: string
  readonly endpointIdentity: string
  readonly model: string
  readonly dimensionMode: string
  readonly configuredDimensions: number | null
  readonly vectorizedChunks: number
  readonly pendingJobs: number
  readonly runningJobs: number
  readonly failedJobs: number
  readonly lastError?: string
}
/** Complete bounded status returned to the Code Index Center. */
export interface CodeIndexManagementStatus {
  readonly workspaceRoot: string
  readonly indexedFileCount: number
  readonly chunkCount: number
  readonly tier: string
  readonly epochs: CodeIndexEpochs
  readonly lastRefresh?: CodeIndexRefreshView
  readonly degraded: boolean
  readonly generations: readonly CodeIndexGenerationView[]
  readonly lastError?: string
}
/** Session-owned workspace selector; Host resolves the cwd instead of trusting a Client path. */
export interface CodeIndexSessionRequest { readonly sessionId: string }
/** Bounded search-debug request. */
export interface CodeIndexSearchDebugRequest extends CodeIndexSessionRequest {
  readonly query: string
  readonly topK?: number
  readonly paths?: readonly string[]
}
/** Destructive rebuild confirmation request. */
export interface CodeIndexRebuildRequest extends CodeIndexSessionRequest { readonly confirmation: string }
/** Compact candidate returned by search debug. */
export interface CodeIndexSearchHit {
  readonly chunkId: string
  readonly filePath: string
  readonly language: string
  readonly contentHash: string
  readonly startLine: number
  readonly endLine: number
  readonly breadcrumb?: string
  readonly symbolName?: string
  readonly symbolKind?: string
  readonly score: number
  readonly graphScore?: number
  readonly rank: number
  readonly reasons: readonly string[]
  readonly scoreTrace: readonly { readonly label: string; readonly value: number }[]
  readonly parserTier: string
  readonly parserConfidence: number
}
/** Compact search result without hydrated source bodies. */
export interface CodeIndexSearchResult {
  readonly query: string
  readonly tier: string
  readonly hits: readonly CodeIndexSearchHit[]
  readonly candidateCount: number
  readonly epochs: CodeIndexEpochs
  readonly truncated: boolean
  readonly degraded: boolean
  readonly readErrors: readonly string[]
}
/** Search result plus the applied top-K budget. */
export interface CodeIndexSearchDebugResult {
  readonly result: CodeIndexSearchResult
  readonly executedTopK: number
}
