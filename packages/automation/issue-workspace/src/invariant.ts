/** Package-owned invariant companion for `@relay-harness/rlh-issue-workspace`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-issue-workspace'
export const name = 'issue-workspace-invariant'
export const inject = ['invariants']
/** No runtime invariant: the provider validates containment at each filesystem mutation. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
