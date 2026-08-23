/**
 * Service Definition for deterministic per-issue workspace lifecycle.
 * @module @deepseek-ai/dsh-issue-workspace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { TrackerIssue } from '@deepseek-ai/dsh-tracker'
import type { IssueWorkspace } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    issueWorkspace: IssueWorkspaceProvisioner
  }
}

/** Provider-neutral workspace creation, attempt hooks, and terminal cleanup. */
export abstract class IssueWorkspaceProvisioner extends Service {
  constructor(ctx: Context) {
    super(ctx, 'issueWorkspace')
  }

  /**
   * Create or reuse one issue workspace.
   * @param issue Issue to prepare.
   * @param signal Cancellation.
   * @returns Prepared workspace after setup.
   */
  abstract prepare(issue: TrackerIssue, signal?: AbortSignal): Promise<IssueWorkspace>
  /**
   * Locate without mutation.
   * @param issue Issue to locate.
   * @param signal Cancellation.
   * @returns Deterministic workspace without mutation.
   */
  abstract locate(issue: TrackerIssue, signal?: AbortSignal): Promise<IssueWorkspace>
  /**
   * Run attempt-blocking setup.
   * @param workspace Prepared workspace.
   * @param issue Owning issue.
   * @param signal Cancellation.
   */
  abstract beforeRun(workspace: IssueWorkspace, issue: TrackerIssue, signal?: AbortSignal): Promise<void>
  /**
   * Run best-effort attempt cleanup.
   * @param workspace Prepared workspace.
   * @param issue Owning issue.
   */
  abstract afterRun(workspace: IssueWorkspace, issue: TrackerIssue): Promise<void>
  /**
   * Remove one terminal workspace.
   * @param workspace Prepared workspace.
   * @param issue Owning terminal issue.
   */
  abstract remove(workspace: IssueWorkspace, issue: TrackerIssue): Promise<void>
}

export default IssueWorkspaceProvisioner
