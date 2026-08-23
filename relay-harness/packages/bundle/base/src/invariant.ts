/**
 * Package-owned invariant companion for `@relay-harness/rlh-base`.
 * @module @relay-harness/rlh-base/invariant
 */

import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-base'

/** Cordis companion plugin name. */
export const name = 'base-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the package is a static patch-list carrier (a YAML
// document of loader rows owned by other packages); it mounts no service,
// emits no events, and owns no mutable relation to check. Each inserted row's
// own package carries that row's invariants.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
