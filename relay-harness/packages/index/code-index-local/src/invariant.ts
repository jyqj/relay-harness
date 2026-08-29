/** Package-owned invariant companion for `@relay-harness/rlh-code-index-local`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-code-index-local'

/** Cordis companion plugin name. */
export const name = 'code-index-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider's owned relationships (epochs read at
 * answer time equal the store ledger; excluded trees never enter results;
 * fold yields one commit per burst) are asserted against real stores inside
 * this package's own scan/diff/composition suites, and every observable
 * cross-plugin relation routes through the `ctx.codeIndex` seam whose other
 * side is the consumer package's ownership.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
