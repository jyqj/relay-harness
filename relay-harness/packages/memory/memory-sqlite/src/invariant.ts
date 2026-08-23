/** Package-owned invariant companion for `@relay-harness/rlh-memory-sqlite`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-memory-sqlite'
export const name = 'memory-sqlite-invariant'
export const inject = ['invariants']

/** No runtime invariant: canonical writes transact revision, current projection, and FTS updates together. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
