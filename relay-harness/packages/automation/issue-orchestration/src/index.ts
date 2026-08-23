/**
 * Service Definition for durable tracker-driven issue automation.
 * @module @relay-harness/rlh-issue-orchestration
 */

import { Context } from '@relay-harness/cordis'
import { TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import type { IssueCommand, IssueOrchestrationSnapshot, IssueRefreshResult } from './types.ts'

export type * from './types.ts'
export { IssueOrchestrationError } from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    issueOrchestration: IssueOrchestration
  }
}

/** Operator/query surface over one durable orchestration authority. */
export abstract class IssueOrchestration extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'issueOrchestration')
  }
  /**
   * Read current operator state.
   * @returns A detached complete operator snapshot.
   */
  abstract snapshot(): IssueOrchestrationSnapshot
  /**
   * Request an immediate poll.
   * @returns A receipt saying whether it was coalesced.
   */
  abstract refresh(): IssueRefreshResult
  /**
   * Retry non-running work.
   * @param command Issue to retry now.
   * @returns After durability.
   */
  abstract retry(command: IssueCommand): Promise<void>
  /**
   * Release non-running work.
   * @param command Issue claim to release.
   * @returns After durability.
   */
  abstract release(command: IssueCommand): Promise<void>
}

export default IssueOrchestration
