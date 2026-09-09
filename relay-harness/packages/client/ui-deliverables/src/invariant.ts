/**
 * Package-owned invariant companion for `@relay-harness/rlh-client-ui-deliverables`.
 * @module @relay-harness/rlh-client-ui-deliverables/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-client-ui-deliverables'

/** Cordis companion plugin name. */
export const name = 'client-ui-deliverables-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the prompt section, slot, dictionary, event
 * definition, and optional service registrations are effect-owned with
 * disposal proven by their plugin specs. The whole-session inventory belongs to the Host work-results owner.
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
