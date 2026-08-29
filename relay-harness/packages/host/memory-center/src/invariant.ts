/** Package-owned invariant companion. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-host-memory-center'
export const name = 'host-memory-center-invariant'
export const inject = ['invariants']
/** No runtime invariant: canonical revision/evidence validation remains provider-owned. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
