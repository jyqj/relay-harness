/**
 * Package-owned invariant companion for `@relay-harness/rlh-tool-code-index`.
 * @module @relay-harness/rlh-tool-code-index/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-tool-code-index'

/** Cordis companion plugin name. */
export const name = 'tool-code-index-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing adapter owns no lifecycle stream of its
 * own beyond a bounded busy counter that never escapes execute's try/finally
 * scope, presenters are pure functions pinned by unit tests, and execution
 * relations are owned by the code-index provider behind the seam.
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
