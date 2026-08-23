/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-orchestration`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-issue-orchestration'
export const name = 'issue-orchestration-invariant'
export const inject = ['invariants']
/** Check that change notifications name the committed authoritative revision. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('issue-orchestration/changed', (revision) => {
    if (ctx.get('issueOrchestration')?.snapshot().revision !== revision) {
      fail(`issue-orchestration/changed revision ${String(revision)} is not authoritative`)
    }
  })
}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
