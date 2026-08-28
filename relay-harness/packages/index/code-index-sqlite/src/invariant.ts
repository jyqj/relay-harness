/** Package-owned invariant companion for `@relay-harness/rlh-code-index-sqlite`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-code-index-sqlite'

/** Cordis companion plugin name. */
export const name = 'code-index-sqlite-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: schema admission and rebuild-on-mismatch are storage contracts
 * asserted against real database files inside this package's own suites, and no
 * observable cross-plugin data relationship exists without a provider installed.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
