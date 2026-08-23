/** Operator-facing issue automation state. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TrackerIssue, TrackerIssueId } from '@deepseek-ai/dsh-tracker/types'

/** Materialized view of one claimed, running, retrying, or blocked issue. */
export interface IssueOrchestrationEntry {
  readonly issue: TrackerIssue
  readonly status: 'claimed' | 'running' | 'retrying' | 'blocked'
  readonly attempt: number
  readonly workspacePath?: string
  readonly sessionId?: SessionId
  readonly startedAt?: number
  readonly lastProgressAt?: number
  readonly nextRetryAt?: number
  readonly error?: string
  readonly updatedAt: number
}

/** Detached complete operator projection. */
export interface IssueOrchestrationSnapshot {
  readonly revision: number
  readonly workflowRevision: string
  readonly checking: boolean
  readonly nextPollAt?: number
  readonly running: readonly IssueOrchestrationEntry[]
  readonly retrying: readonly IssueOrchestrationEntry[]
  readonly blocked: readonly IssueOrchestrationEntry[]
}

/** Result of coalescing an operator refresh request into the serialized driver. */
export interface IssueRefreshResult {
  readonly queued: true
  readonly coalesced: boolean
  readonly requestedAt: number
}

/** Stable operation rejection suitable for API mapping. */
export class IssueOrchestrationError extends Error {
  constructor(
    message: string,
    readonly code: 'ISSUE_NOT_FOUND' | 'ISSUE_RUNNING' | 'ISSUE_NOT_BLOCKED' | 'INVALID_OPERATION',
  ) {
    super(message)
    this.name = 'IssueOrchestrationError'
  }
}

/** Operator command scoped to one provider-owned issue identity. */
export interface IssueCommand {
  readonly issueId: TrackerIssueId
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Durable orchestration state changed; observers re-read `snapshot()`.
     * @param revision Authoritative process-local projection revision.
     * @mode emit
     */
    'issue-orchestration/changed'(revision: number): void
  }
}
