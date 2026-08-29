/** Package-owned invariant companion. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-client-ui-memory-center'
export const name = 'ui-memory-center-invariant'
export const inject = ['invariants']
/** No runtime invariant: the browser cache owns no durable state. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
