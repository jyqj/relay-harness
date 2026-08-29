/** Package-owned invariant companion for `@relay-harness/rlh-issue-orchestrator`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-issue-orchestrator'
export const name = 'issue-orchestrator-invariant'
export const inject = ['invariants']
/** No runtime invariant: the Service Definition companion checks published revisions and storage validates records. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
