/**
 * Service Definition for repository-owned issue automation policy.
 * @module @deepseek-ai/dsh-issue-workflow
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IssueWorkflowSnapshot } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    issueWorkflow: IssueWorkflow
  }
  interface Events {
    /**
     * A new validated workflow revision became authoritative.
     * @param next Newly committed immutable snapshot.
     * @param previous Replaced last-known-good snapshot.
     * @mode emit
     */
    'issue-workflow/updated'(next: IssueWorkflowSnapshot, previous: IssueWorkflowSnapshot): void
  }
}

/** Last-known-good workflow provider with explicit reload. */
export abstract class IssueWorkflow extends Service {
  constructor(ctx: Context) {
    super(ctx, 'issueWorkflow')
  }
  /**
   * Read the current workflow.
   * @returns The immutable authoritative revision.
   */
  abstract current(): IssueWorkflowSnapshot
  /**
   * Re-read the workflow source.
   * @returns True only when a different valid revision commits.
   */
  abstract reload(): Promise<boolean>
}

export default IssueWorkflow
