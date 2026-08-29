/** Package-owned invariant companion for `@relay-harness/rlh-issue-runner-agent`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-issue-runner-agent'
export const name = 'issue-runner-agent-invariant'
export const inject = ['invariants']
/** No runtime invariant: Agent/Session and Tool Runtime companions own the relationships this provider composes. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
