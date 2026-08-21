/**
 * Package invariant companion for the LLM circuit breaker.
 * @module @deepseek-ai/dsh-llm-circuit-breaker/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'llm-circuit-breaker-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
const install: InvariantInstaller = () => {}

/**
 * Register the package-owned no-relation invariant.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer after setup.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-llm-circuit-breaker', install))
/* jscpd:ignore-end */
