/** Package-owned invariant companion for the workspace Code Index router. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
export const name = 'code-index-workspace-router-invariant'
export const inject = ['invariants']
/** No runtime invariant: canonical workspace binding and runtime lease ownership are enforced inside the router. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@relay-harness/rlh-code-index-workspace-router', install))
