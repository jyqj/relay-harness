/** Package-owned invariant companion for `@relay-harness/rlh-mcp-catalog`. */
/* jscpd:ignore-start */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
const PACKAGE_NAME = '@relay-harness/rlh-mcp-catalog'
export const name = 'mcp-catalog-invariant'
export const inject = ['invariants']
/** No runtime invariant: generation replacement validates and freezes every MCP catalog record. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
