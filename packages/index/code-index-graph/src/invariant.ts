/** Package-owned invariant companion for `@relay-harness/rlh-code-index-graph`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-code-index-graph'

/** Cordis companion plugin name. */
export const name = 'code-index-graph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the resolver is a stateless rows-in/rows-out function
 * over a caller-owned catalog with no mutable data or event relationships to
 * assert. Its behavioral surface (ladder order, penalties, gates) is pinned
 * by this package's own suites.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
