/** Package-owned invariant companion for `@relay-harness/rlh-issue-runner`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-issue-runner'
export const name = 'issue-runner-invariant'
export const inject = ['invariants']
/** No runtime invariant: each provider owns publication, result, and disposal settlement. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
