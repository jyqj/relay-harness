/** Package-owned invariant companion for `@relay-harness/rlh-prompt-enhancement-context-engine`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-prompt-enhancement-context-engine'

/** Cordis companion plugin name. */
export const name = 'prompt-enhancement-context-engine-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this adapter delegates once to the existing Context
 * Engine and projects its typed prepared result without owning durable state.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
