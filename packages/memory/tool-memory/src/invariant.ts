/** Package-owned invariant companion for `@deepseek-ai/dsh-tool-memory`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-memory'
export const name = 'tool-memory-invariant'
export const inject = ['invariants']

/** No runtime invariant: the tool executor validates evidence before the provider commits a revision. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
