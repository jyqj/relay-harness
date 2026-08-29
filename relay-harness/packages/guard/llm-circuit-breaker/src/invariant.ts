/**
 * Package invariant companion for the LLM circuit breaker.
 * @module @relay-harness/rlh-llm-circuit-breaker/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

/** Cordis companion plugin name. */
export const name = 'llm-circuit-breaker-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
/** No runtime invariant: request/result event relationships are owned by the Agent Loop invariant. */
const install: InvariantInstaller = () => {}

/**
 * Register the package-owned no-relation invariant.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer after setup.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@relay-harness/rlh-llm-circuit-breaker', install))
/* jscpd:ignore-end */
