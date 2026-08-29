/** Package-owned invariant companion for `@relay-harness/rlh-client-ui-prompt-enhancement`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-client-ui-prompt-enhancement'

/** Cordis companion plugin name. */
export const name = 'client-ui-prompt-enhancement-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the control is a reversible slot registration and its
 * compare-before-replace behavior is covered through the real input facade.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
