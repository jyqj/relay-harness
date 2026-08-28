/**
 * Router/framework constant tables for the JS/TS walker. In this phase the
 * tables exist so the walker's call-site branching is already shaped for the
 * route/http extraction phase, but no route or HTTP edges are produced yet.
 * @module
 */

/**
 * Router objects that register routes (`app.get(...)`, `router.post(...)`).
 * Transcribed from the reference implementation (`jsts/routes.rs`).
 */
export const ROUTER_OBJECTS: ReadonlySet<string> = new Set([
  'app',
  'router',
  'server',
  'api',
  'route',
  'routes',
  'fastify',
  'hono',
])

/** HTTP methods for route detection. */
export const ROUTE_METHODS: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
  'use',
])

/** NestJS method-decorator names (`@Get`, `@Post`, ...), lowercase. */
export const NESTJS_DECORATORS: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'all',
])
