/** Package-private registration state shared by the server and its read-only invariant companion. */
import type { Context, Fiber } from '@relay-harness/cordis'
import type { WebRoute, WebUpgradeRoute } from './index.ts'

/** Stable across the independently bundled service and invariant entrypoints. */
export const routeStateKey = Symbol.for('@relay-harness/rlh-host-webserver/route-state')

/** One actual registration occurrence and its owning Cordis activation lifetime. */
export interface RouteRegistration<T> {
  readonly value: T
  readonly owner: Fiber
  active: boolean
  readonly releaseOwner: () => void
}

/** The sole tables used by request dispatch, not a diagnostic projection. */
export interface RouteState {
  readonly exact: Map<string, RouteRegistration<WebRoute>>
  readonly prefixes: Map<string, RouteRegistration<WebRoute>>
  readonly upgrades: Map<string, RouteRegistration<WebUpgradeRoute>>
  readonly indexTaps: RouteRegistration<(html: string) => string>[]
  fallback: RouteRegistration<WebRoute['handler']> | undefined
}

/**
 * Bind an occurrence to the caller's actual Cordis effect lifetime, including reloads of the same fiber.
 * @param ctx - context through which the registration was requested.
 * @param value - captured handler or route descriptor.
 * @returns the dispatch record; its disposer releases the activation fence.
 */
export function registration<T>(ctx: Context, value: T): RouteRegistration<T> {
  const row: RouteRegistration<T> = { value, owner: ctx.fiber, active: true, releaseOwner: () => { void stop() } }
  const stop = ctx.effect(() => () => { row.active = false }, 'webServer.registration-owner')
  return row
}

/** Read the server instance's private dispatch tables across separately bundled entrypoints.
 * @param server - the live webserver service instance.
 * @returns its authoritative registration state.
 */
export function routeStateOf(server: object): RouteState {
  return Reflect.get(server, routeStateKey) as RouteState
}
