/** Package-owned invariant companion for `@relay-harness/rlh-tool-memory`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-tool-memory'
export const name = 'tool-memory-invariant'
export const inject = ['invariants']

/** No runtime invariant: the tool executor validates evidence before the provider commits a revision. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
