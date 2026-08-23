/** Package-owned invariant companion for `@relay-harness/rlh-attachment-local`. @module @relay-harness/rlh-attachment-local/invariant */

/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-attachment-local'
/** Cordis companion plugin name. */
export const name = 'attachment-local-invariant'
/** Services required before package ownership can be reserved. */
export const inject = ['invariants', 'attachments']
/** No runtime invariant: immutable writes and verified reads are enforced directly at the backend boundary. */
const install: InvariantInstaller = () => {}
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
