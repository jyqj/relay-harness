/**
 * Structured failure codes for the code-index tool consumer. Package-owned
 * (not `CODE_INDEX_*`) because these describe the CONSUMER's relationship to
 * the optional seam — availability, this package's own busy guard, and opaque
 * provider failures — while stable provider vocabulary (`CODE_INDEX_*`)
 * propagates through unchanged.
 *
 * @module @relay-harness/rlh-tool-code-index/errors
 */

import type { Context } from '@relay-harness/cordis'
import type { CodeIndex, CodeIndexWorkspace } from '@relay-harness/rlh-code-index'
import { HarnessError } from '@relay-harness/rlh-llm'
import type { ToolExecution } from '@relay-harness/rlh-tools'

/** No `ctx.codeIndex` service is loaded in the deployment: the provider plugin is missing. */
export const INDEX_TOOL_UNAVAILABLE = 'INDEX_TOOL_UNAVAILABLE'

/**
 * A refresh call arrived while this plugin already awaits an earlier
 * tool-initiated pass. The seam folds concurrency into one pass, so this guard
 * is deliberate: it gives the model immediate structured feedback instead of a
 * second identical commit waiting behind the fold.
 */
export const INDEX_TOOL_REFRESH_IN_PROGRESS = 'INDEX_TOOL_REFRESH_IN_PROGRESS'

/** The loaded `ctx.codeIndex` implementation rejected a call with a non-`HarnessError` throw. */
export const INDEX_TOOL_FAILED = 'INDEX_TOOL_FAILED'

/** Stable, machine-routable codes carried by {@link CodeIndexToolError}. */
export type CodeIndexToolErrorCode =
  | typeof INDEX_TOOL_UNAVAILABLE
  | typeof INDEX_TOOL_REFRESH_IN_PROGRESS
  | typeof INDEX_TOOL_FAILED

/**
 * Typed code-index tool failure. Extends {@link HarnessError} so it carries a
 * stable {@link CodeIndexToolErrorCode} and chains `cause`; the tool registry
 * exposes `{ name, code }` on `isError` results so retry/UI layers can branch
 * without parsing messages.
 */
export class CodeIndexToolError extends HarnessError {
  override readonly code: CodeIndexToolErrorCode

  constructor(message: string, code: CodeIndexToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/**
 * Resolve the optional code-index seam at execution time (`ctx.get`, not static
 * inject) and fail loud with {@link INDEX_TOOL_UNAVAILABLE} when no provider is
 * loaded. Misconfiguration here is a DEPLOYMENT gap (a missing plugin), not a
 * loop crash: throwing a structured {@link CodeIndexToolError} surfaces as an
 * ordinary `isError` tool result the model can read and act on.
 *
 * @param ctx - the plugin context; looks up `ctx.codeIndex` opportunistically.
 * @param toolName - the calling tool name, used in messages.
 * @returns the loaded seam instance.
 */
export function requireCodeIndex(ctx: Context, toolName: string): CodeIndex {
  const codeIndex = ctx.get('codeIndex')
  if (!codeIndex) {
    throw new CodeIndexToolError(
      `${toolName} requires a code-index provider: no ctx.codeIndex service is loaded in this deployment`,
      INDEX_TOOL_UNAVAILABLE,
    )
  }
  return codeIndex
}

/** Resolve the calling Agent's durable Session cwd into a workspace-bound index face.
 * @param ctx - execution context carrying the optional Code Index provider.
 * @param toolName - model-facing tool identity used in diagnostics.
 * @param exec - exact Tool execution and owning Agent Session.
 * @returns workspace-bound Code Index face.
 */
export async function requireWorkspaceCodeIndex(
  ctx: Context,
  toolName: string,
  exec: Readonly<ToolExecution>,
): Promise<CodeIndexWorkspace> {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) {
    throw new CodeIndexToolError(
      `${toolName} requires an Agent Session with a workspace cwd`,
      INDEX_TOOL_FAILED,
    )
  }
  const provider = requireCodeIndex(ctx, toolName)
  if (typeof provider.forWorkspace === 'function') return provider.forWorkspace(cwd)
  return {
    workspaceRoot: cwd,
    status: () => provider.status(),
    managementStatus: () => provider.managementStatus(),
    reconcile: () => provider.reconcile(),
    refresh: options => provider.refresh(options),
    search: (request, signal) => provider.search(request, signal),
    hydrateChunks: (request, signal) => provider.hydrateChunks(request, signal),
    exploreGraph: (request, signal) => provider.exploreGraph(request, signal),
  }
}

/**
 * Normalize one provider-side rejection into the tool error model.
 * Provider-stable `HarnessError`s (for example `CODE_INDEX_NOT_INDEXED`) ride
 * through unchanged so their vocabulary stays visible on `isError` results;
 * anything else becomes {@link CodeIndexToolError} with
 * {@link INDEX_TOOL_FAILED} and the original as `cause`.
 *
 * @param toolName - the calling tool name, used in messages.
 * @param error - what the seam threw or rejected with.
 * @returns the error to surface as a structured, loop-contained failure.
 */
export function normalizeCodeIndexFailure(toolName: string, error: unknown): HarnessError {
  if (error instanceof HarnessError) return error
  return new CodeIndexToolError(`${toolName} failed: ${String(error)}`, 'INDEX_TOOL_FAILED', { cause: error })
}
