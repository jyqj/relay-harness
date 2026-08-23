/**
 * Package-owned invariant companion for `@relay-harness/rlh-client-ui-session-tree`.
 * @module @relay-harness/rlh-client-ui-session-tree/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-client-ui-session-tree'

/** Cordis companion plugin name. */
export const name = 'client-ui-session-tree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package derives a read-only graph from Session
 * summaries and history, while mutations delegate to the existing Session
 * and Workspace services.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
