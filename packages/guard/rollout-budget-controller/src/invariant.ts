/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-rollout-budget-controller`.
 * @module @deepseek-ai/dsh-rollout-budget-controller/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-rollout-budget-controller'

/** Cordis companion plugin name. */
export const name = 'rollout-budget-controller-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the authoritative inputs are immutable per-session
 * usage events, while cross-session totals and reminder deliveries are private
 * process-local projections with no independent public relation to check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
