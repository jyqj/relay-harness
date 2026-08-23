/** Package-owned invariant companion for `@deepseek-ai/dsh-tracker`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tracker'

/** Cordis companion plugin name. */
export const name = 'tracker-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Check that provider lifecycle events agree with the registry's authoritative membership. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('tracker/provider-added', (provider) => {
    const registry = ctx.get('trackers')
    if (registry === undefined || !registry.list().includes(provider.name) || registry.require(provider.name) !== provider) {
      fail(`tracker/provider-added for ${JSON.stringify(provider.name)} does not match the registry`)
    }
  })
  ctx.on('tracker/provider-removed', (providerName) => {
    if (ctx.get('trackers')?.list().includes(providerName) === true) {
      fail(`tracker/provider-removed for ${JSON.stringify(providerName)} remains registered`)
    }
  })
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
