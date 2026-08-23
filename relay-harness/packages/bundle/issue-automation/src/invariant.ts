/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-automation`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-issue-automation'
export const name = 'issue-automation-invariant'
export const inject = ['invariants']
/** No runtime invariant: this package is a declarative bundle over package-owned companions. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
