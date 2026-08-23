/**
 * Package-owned invariant companion for `@relay-harness/rlh-atomic-write`.
 * @module @relay-harness/rlh-atomic-write/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-atomic-write'

/** Cordis companion plugin name. */
export const name = 'atomic-write-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this pure filesystem primitive owns no event stream or mutable runtime
 * data; its replacement contract is enforced by unit tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
