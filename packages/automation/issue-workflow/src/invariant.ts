/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-workflow`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-issue-workflow'
export const name = 'issue-workflow-invariant'
export const inject = ['invariants']
/** Check update events against the provider's committed revision. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('issue-workflow/updated', (next, previous) => {
    if (next.revision === previous.revision) fail('issue-workflow/updated repeated the previous revision')
    if (ctx.get('issueWorkflow')?.current().revision !== next.revision) {
      fail('issue-workflow/updated does not match the authoritative current revision')
    }
  })
}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
