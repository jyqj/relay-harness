/**
 * Canonical filesystem resource identities for cross-tool read/write locking.
 * @module @relay-harness/rlh-tool-fs/resource
 */

import type { Context } from '@relay-harness/cordis'
import type { ToolExecution, ToolResourceIntent } from '@relay-harness/rlh-tools'
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * Resolve one requested path to the provider's stable target identity.
 * @param ctx - tool context supplying the active filesystem provider.
 * @param exec - call identity, session cwd, and cancellation.
 * @param path - model-requested path resolved exactly like the tool body.
 * @param access - read or write lock mode.
 * @returns one namespaced canonical filesystem claim.
 */
export async function fileResourceIntent(
  ctx: Context,
  exec: Readonly<ToolExecution>,
  path: string,
  access: ToolResourceIntent['access'],
): Promise<ToolResourceIntent> {
  const target = await ctx.fs.resolve(path, sessionResolveOptions(exec, path))
  return { key: `fs:${String(target.targetKey)}`, access }
}

