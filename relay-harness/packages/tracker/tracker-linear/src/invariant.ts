/** Package-owned invariant companion for `@deepseek-ai/dsh-tracker-linear`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-tracker-linear'
export const name = 'tracker-linear-invariant'
export const inject = ['invariants']
/** No runtime invariant: tracker registry ownership and binding validation cover this provider. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
