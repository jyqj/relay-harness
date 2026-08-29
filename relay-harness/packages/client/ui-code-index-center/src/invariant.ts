/**
 * Package-owned invariant companion for `@relay-harness/rlh-client-ui-code-index-center`.
 * @module @relay-harness/rlh-client-ui-code-index-center/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-client-ui-code-index-center'

/** Cordis companion plugin name. */
export const name = 'client-ui-code-index-center-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings slot lifecycle and generated Remote
 * contract own this presentation-only projection; package tests cover Session
 * switching, stale response suppression, and destructive confirmation.
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
