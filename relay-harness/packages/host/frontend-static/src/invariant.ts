/**
 * Package-owned invariant companion for `@relay-harness/rlh-host-frontend-static`.
 * @module @relay-harness/rlh-host-frontend-static/invariant
 */

import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-host-frontend-static'

/** Cordis companion plugin name. */
export const name = 'host-frontend-static-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the webserver owns fallback registration state and
 * verifies its activation lifetime after the contributing fiber quiesces.
 * This package supplies the fallback handler but owns no independent mutable
 * route table; file-serving and HMR behavior are exercised by its real-composition tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
