/** Package-owned invariant companion for `@relay-harness/rlh-issue-automation`. */
/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-issue-automation'
export const name = 'issue-automation-invariant'
export const inject = ['invariants']
/** No runtime invariant: this package is a declarative bundle over package-owned companions. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
