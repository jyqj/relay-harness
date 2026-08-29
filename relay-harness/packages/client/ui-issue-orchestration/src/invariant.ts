/** Package-owned invariant companion for `@relay-harness/rlh-client-ui-issue-orchestration`. */
/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-client-ui-issue-orchestration'
export const name = 'client-ui-issue-orchestration-invariant'
export const inject = ['invariants']
/** No runtime invariant: slot registration and generated Remote contracts own this presentation path. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
