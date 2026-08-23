/**
 * Package-owned invariant companion for `@relay-harness/rlh-client-ui-diff`.
 * @module @relay-harness/rlh-client-ui-diff/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-client-ui-diff'

/** Cordis companion plugin name. */
export const name = 'client-ui-diff-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a pure-consumer plugin that reads session cwd and
 * desktop git diff IPC through injected callbacks — it emits no cordis
 * events and owns no cross-plugin mutable state.
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
