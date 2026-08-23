/** Package-owned invariant companion for `@relay-harness/rlh-memory-agent`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-memory-agent'
export const name = 'memory-agent-invariant'
export const inject = ['invariants']

/** No runtime invariant: Agent loop admission already asserts every accepted recall message is logged verbatim. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
