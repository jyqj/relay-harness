/** Package-owned invariant companion. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-memory-outcome-reconciler'
export const name = 'memory-outcome-reconciler-invariant'
export const inject = ['invariants']
/** No runtime invariant: canonical provider validation owns the derived outcome transaction. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

