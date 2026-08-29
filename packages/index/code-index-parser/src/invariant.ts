/** Package-owned invariant companion for `@relay-harness/rlh-code-index-parser`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-code-index-parser'

/** Cordis companion plugin name. */
export const name = 'code-index-parser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the parser is a stateless text→records function with
 * no mutable data or event relationships to assert. Its correctness surface
 * (deterministic ids, grammar provenance, coexistence with the SQLite lane)
 * is pinned by this package's own suites.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
