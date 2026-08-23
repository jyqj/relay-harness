/** Live issue-runner protocol shared by orchestration and execution providers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { TrackerIssue, TrackerToolBinding } from '@deepseek-ai/dsh-tracker/types'
import type { IssueWorkspace } from '@deepseek-ai/dsh-issue-workspace/types'

/** Stable identity of one issue execution attempt. */
export type IssueRunId = Branded<'IssueRunId'>

/** Operator-facing progress from one live issue run. */
export interface IssueRunEvent {
  readonly at: number
  readonly kind: 'session-started' | 'assistant' | 'tool' | 'turn-ended'
  readonly sessionId: SessionId
  readonly event?: SessionEvent
}

/** Never-rejecting terminal result of one published issue run. */
export interface IssueRunResult {
  readonly stopReason: 'completed' | 'failed' | 'blocked' | 'cancelled'
  readonly sessionId: SessionId
  readonly turns: number
  readonly error?: string
}

/** Published run whose holder owns cancellation and quiescent disposal. */
export interface IssueRun {
  readonly id: IssueRunId
  readonly sessionId: SessionId
  readonly result: Promise<IssueRunResult>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

/** Run inputs resolved and captured before publication. */
export interface IssueRunRequest {
  readonly issue: TrackerIssue
  readonly workspace: IssueWorkspace
  readonly attempt: number
  readonly prompt: string
  readonly continuationPrompt: (turn: number, maxTurns: number) => string
  readonly maxTurns: number
  readonly trackerTools: TrackerToolBinding
  readonly refreshIssue: (signal: AbortSignal) => Promise<TrackerIssue | undefined>
  readonly shouldContinue: (issue: TrackerIssue) => boolean
  readonly onEvent?: (event: IssueRunEvent) => void
  readonly signal?: AbortSignal
}
