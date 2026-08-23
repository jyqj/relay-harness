/** Package-owned invariant companion for `@relay-harness/rlh-tracker-linear`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-tracker-linear'
export const name = 'tracker-linear-invariant'
export const inject = ['invariants']
/** No runtime invariant: tracker registry ownership and binding validation cover this provider. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
