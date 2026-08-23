/** Package-owned invariant companion for `@deepseek-ai/dsh-memory-agent`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-agent'
export const name = 'memory-agent-invariant'
export const inject = ['invariants']

/** No runtime invariant: Agent loop admission already asserts every accepted recall message is logged verbatim. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
