/** Package-owned invariant companion for `@deepseek-ai/dsh-memory-sqlite`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-sqlite'
export const name = 'memory-sqlite-invariant'
export const inject = ['invariants']

/** No runtime invariant: canonical writes transact revision, current projection, and FTS updates together. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
