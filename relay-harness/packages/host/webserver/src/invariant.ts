/**
 * Package-owned invariant companion for `@relay-harness/rlh-host-webserver`.
 * @module @relay-harness/rlh-host-webserver/invariant
 */

/* jscpd:ignore-start */
import { FiberState, type Context } from '@relay-harness/cordis'
import { routeStateOf } from './route-state.ts'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'

const PACKAGE_NAME = '@relay-harness/rlh-host-webserver'

/** Cordis companion plugin name. */
export const name = 'host-webserver-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** Actual dispatch tables cannot retain registrations after their owning activation has quiesced. */
const install: InvariantInstaller = (ctx, fail) => {
  // The effect fence distinguishes hot reloads even when the same Fiber object survives.
  ctx.on('internal/status', (fiber) => {
    if (fiber.state !== FiberState.UNLOADING) return
    void (async () => {
      await Promise.resolve()
      while (fiber.inertia !== undefined) await fiber.inertia
      const server = ctx.get('webServer')
      if (server === undefined) return
      const state = routeStateOf(server)
      const rows = [
        ...state.exact.values(), ...state.prefixes.values(), ...state.upgrades.values(),
        ...state.indexTaps, ...state.fallback === undefined ? [] : [state.fallback],
      ]
      if (rows.some(row => row.owner === fiber && !row.active)) {
        fail('webServer dispatch registry retained a registration after its owning activation quiesced')
      }
    })().catch((error: unknown) => { ctx.logger.error(error) })
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
