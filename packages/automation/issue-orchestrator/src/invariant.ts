/** Package-owned invariant companion for `@deepseek-ai/dsh-issue-orchestrator`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-issue-orchestrator'
export const name = 'issue-orchestrator-invariant'
export const inject = ['invariants']
/** No runtime invariant: the Service Definition companion checks published revisions and storage validates records. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
