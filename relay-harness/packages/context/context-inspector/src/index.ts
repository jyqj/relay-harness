/** Register the durable Context Inspector session projection. */
import type { Context } from '@relay-harness/cordis'
import { contextInspectorProjectionDefinition } from './projection.ts'
export type * from './types.ts'
export { contextInspectorProjectionDefinition } from './projection.ts'
export const name = 'context-inspector'
export const inject = ['sessionProjections']
export function apply(ctx: Context): void { ctx.sessionProjections.register(contextInspectorProjectionDefinition) }
