/** Package-owned invariant companion for `@relay-harness/rlh-issue-orchestration`. */

import type { Context } from '@relay-harness/cordis'
import type { InvariantFailure, InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-issue-orchestration'
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
