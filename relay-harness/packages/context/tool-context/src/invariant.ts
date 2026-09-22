/**
 * Package-owned invariant companion for `@relay-harness/rlh-tool-context`.
 * @module @relay-harness/rlh-tool-context/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-tool-context'

/** Cordis companion plugin name. */
export const name = 'tool-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: retrieval is read-only and owns no durable lifecycle. Source generation and
 * cancellation invariants belong to Context Engine; the shared Tool registry
 * validates the result and records its single model-visible delivery.
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
