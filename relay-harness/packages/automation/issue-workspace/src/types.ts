/** Issue-workspace values shared by provisioners and orchestration consumers. */

import type { TrackerIssueId } from '@deepseek-ai/dsh-tracker/types'

/** Stable prepared directory for one tracker issue. */
export interface IssueWorkspace {
  readonly issueId: TrackerIssueId
  readonly path: string
  readonly created: boolean
  readonly preparedAt: number
}
