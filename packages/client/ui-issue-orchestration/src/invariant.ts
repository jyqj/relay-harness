/** Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-issue-orchestration`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-issue-orchestration'
export const name = 'client-ui-issue-orchestration-invariant'
export const inject = ['invariants']
/** No runtime invariant: slot registration and generated Remote contracts own this presentation path. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
