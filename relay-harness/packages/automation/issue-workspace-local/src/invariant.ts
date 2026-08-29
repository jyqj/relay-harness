/** Package-owned invariant companion for `@relay-harness/rlh-issue-workspace-local`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-issue-workspace-local'
export const name = 'issue-workspace-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: local filesystem containment is enforced at the mutating calls. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
