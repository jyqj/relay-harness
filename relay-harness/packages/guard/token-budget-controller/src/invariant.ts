/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-token-budget-controller`.
 * @module @deepseek-ai/dsh-token-budget-controller/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-token-budget-controller'

/** Cordis companion plugin name. */
export const name = 'token-budget-controller-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the continuation decision is a pure function of the session
 * log at the stop boundary, and the only package-local state (per-agent continuation
 * counters in a WeakMap) is observable by no independent event or data relation.
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
