/** Package-owned invariant companion for Code Index Center. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
export const name = 'code-index-center-invariant'
export const inject = ['invariants']
/** No runtime invariant: attached-session lookup and strict Remote codecs enforce the management boundary. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@relay-harness/rlh-host-code-index-center', install))
