/** Package-owned invariant companion for `@deepseek-ai/dsh-memory-extractor-llm`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-extractor-llm'
export const name = 'memory-extractor-llm-invariant'
export const inject = ['invariants']

/** No runtime invariant: queue leases and provider evidence checks enforce extraction relationships at commit. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
