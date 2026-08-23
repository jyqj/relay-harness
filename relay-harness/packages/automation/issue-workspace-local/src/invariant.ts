/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-workspace-local`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-issue-workspace-local'
export const name = 'issue-workspace-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: local filesystem containment is enforced at the mutating calls. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
