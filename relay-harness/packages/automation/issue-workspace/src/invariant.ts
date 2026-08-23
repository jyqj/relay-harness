/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-workspace`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-issue-workspace'
export const name = 'issue-workspace-invariant'
export const inject = ['invariants']
/** No runtime invariant: the provider validates containment at each filesystem mutation. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
