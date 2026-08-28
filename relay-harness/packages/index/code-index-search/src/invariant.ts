/** Package-owned invariant companion for `@relay-harness/rlh-code-index-search`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-code-index-search'

/** Cordis companion plugin name. */
export const name = 'code-index-search-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: fusion/replan relationships (per-file preselect bill
 * summing to the file score, trace total equaling the hit score) are pure
 * functions asserted against real fixtures inside this package's own suites,
 * and no observable data relationship exists without a provider-installed
 * port.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
