/** Durable issue-orchestrator domain schema. */

import { z } from 'zod'
import { SessionId } from '@relay-harness/rlh-session'
import { TrackerIssueId } from '@relay-harness/rlh-tracker'
import { defineDomain, domainTable } from '@relay-harness/rlh-storage-domain'
import type { SessionId as SessionIdValue } from '@relay-harness/rlh-session/types'
import type { TrackerIssue, TrackerIssueId as TrackerIssueIdValue } from '@relay-harness/rlh-tracker/types'

const issueId = z.string().transform(TrackerIssueId)

/** Durable normalized tracker issue schema. */
export const trackerIssue = z.object({
  id: issueId,
  nativeRef: z.record(z.string(), z.json()).optional(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.number().optional(),
  state: z.string(),
  branchName: z.string().optional(),
  url: z.string().optional(),
  assigneeId: z.string().optional(),
  labels: z.array(z.string()),
  blockedBy: z.array(issueId),
  dispatchable: z.boolean(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  revision: z.string().optional(),
})

/** Complete durable scheduling record for one claimed issue. */
export interface IssueOrchestrationRecord {
  readonly provider: string
  readonly workflowRevision: string
  readonly issue: TrackerIssue
  readonly status: 'claimed' | 'running' | 'retrying' | 'blocked'
  readonly attempt: number
  readonly workspacePath?: string
  readonly sessionId?: SessionIdValue
  readonly startedAt?: number
  readonly lastProgressAt?: number
  readonly nextRetryAt?: number
  readonly error?: string
  readonly updatedAt: number
}

/** Durable validator for one scheduling record. */
export const issueOrchestrationRecord = z.object({
  provider: z.string(),
  workflowRevision: z.string(),
  issue: trackerIssue,
  status: z.enum(['claimed', 'running', 'retrying', 'blocked']),
  attempt: z.number().int().positive(),
  workspacePath: z.string().optional(),
  sessionId: z.string().transform(SessionId).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  lastProgressAt: z.number().int().nonnegative().optional(),
  nextRetryAt: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
}) as unknown as z.ZodType<IssueOrchestrationRecord>

/** Storage-domain declaration for issue scheduling records. */
export const issueOrchestratorDomainSpec = defineDomain({
  name: 'issue_orchestrator',
  version: 1,
  tables: {
    issues: domainTable<TrackerIssueIdValue, IssueOrchestrationRecord>(issueOrchestrationRecord),
  },
})
