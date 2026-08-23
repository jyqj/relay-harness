/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-runner`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-issue-runner'
export const name = 'issue-runner-invariant'
export const inject = ['invariants']
/** No runtime invariant: each provider owns publication, result, and disposal settlement. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
