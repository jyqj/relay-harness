/** Package-owned invariant companion for `@relay-harness/rlh-prompt-enhancement-llm`. */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-prompt-enhancement-llm'

/** Cordis companion plugin name. */
export const name = 'prompt-enhancement-llm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: request logging precedes the auxiliary dispatch in one
 * synchronous operation, while exact fields and tool absence are covered by tests.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
