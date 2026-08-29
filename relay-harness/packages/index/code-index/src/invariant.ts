/** Package-owned invariant companion for `@relay-harness/rlh-code-index`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-code-index'

/** Cordis companion plugin name. */
export const name = 'code-index-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: epoch-advance and rebuild-monotonicity are storage contracts asserted
 * inside the SQLite provider's own suites against real transactions, and no observable data
 * relationship exists here without a provider installed.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
