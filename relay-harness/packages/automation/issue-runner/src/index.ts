/**
 * Service Definition for one prepared tracker-issue execution attempt.
 * @module @deepseek-ai/dsh-issue-runner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IssueRun, IssueRunRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    issueRunner: IssueRunner
  }
}

/** Provider-neutral publisher of holder-owned issue runs. */
export abstract class IssueRunner extends Service {
  constructor(ctx: Context) {
    super(ctx, 'issueRunner')
  }

  /**
   * Prepare and publish one run, or reject before returning a handle.
   * @param request Captured issue, workspace, policy, tools, and callbacks.
   * @returns The holder-owned published run.
   */
  abstract start(request: IssueRunRequest): Promise<IssueRun>
}

export default IssueRunner
