/**
 * The model-facing `refresh_code_index` tool over the optional
 * `ctx.codeIndex` seam: bring the derived index up to date with the workspace
 * tree (or force a full rebuild). The seam folds concurrent passes into one
 * commit; this tool ADDS a busy guard so a second model call while a pass is
 * still awaited gets immediate structured feedback
 * (`INDEX_TOOL_REFRESH_IN_PROGRESS`) instead of queueing behind the fold for an
 * identical second summary.
 *
 * @module @relay-harness/rlh-tool-code-index/refresh-tool
 */

import type { Context } from '@relay-harness/cordis'
import type { RefreshSummary } from '@relay-harness/rlh-code-index'
import { defineTool } from '@relay-harness/rlh-tools'
import type { GenericCallView, ToolResult, ToolResultView } from '@relay-harness/rlh-tools'
import { CodeIndexToolError, INDEX_TOOL_REFRESH_IN_PROGRESS, normalizeCodeIndexFailure, requireWorkspaceCodeIndex } from './errors.ts'
import { BUILD_EXPLAIN_SCHEMA } from './build-explain-schema.ts'

/** Validated `refresh_code_index` arguments. */
export interface RefreshCodeIndexArgs {
  force?: boolean
}

/**
 * Tool-owned guard over one awaited refresh pass per plugin instance. The seam
 * folds duplicates; the guard turns "another identical summary later" into a
 * structured busy answer now. Mutated only inside execute's try/finally pair.
 */
const inFlightRefreshes = new Set<string>()

/**
 * Render one completed refresh summary as deterministic `key: value` lines.
 *
 * @param summary - the committed refresh outcome (`reason` widened to its string label).
 * @returns the model-facing text.
 */
export function renderRefreshOutput(summary: Omit<RefreshSummary, 'reason'> & { reason: string }): string {
  const explain = summary.explain
  return [
    'refresh complete',
    `reason: ${summary.reason}`,
    `changedFiles: ${summary.changedFiles}`,
    `removedFiles: ${summary.removedFiles}`,
    `chunksWritten: ${summary.chunksWritten}`,
    `durationMs: ${summary.durationMs}`,
    `indexEpoch now: ${summary.epochsAfter.indexEpoch}`,
    ...(explain === undefined ? [] : [
      `build: scope=${explain.scope} pass=${explain.pass} degraded=${String(explain.degraded)}`,
      `dirty: ${explain.dirty?.status ?? 'not-run'} marked=${explain.dirty?.marked ?? 0}`,
      `embedding: missing=${explain.embedding?.missingChunks ?? 0} enqueued=${explain.embedding?.jobsEnqueued ?? 0} `
        + `batches=${explain.embedding?.batchesWritten ?? 0}`,
    ]),
  ].join('\n')
}

/**
 * Pending-call presentation: a plain titled card reflecting the rebuild choice.
 *
 * @param args - the raw tool arguments; `force` feeds the title.
 * @returns the generic card view shown while the call runs.
 */
export function presentRefreshCall(args: RefreshCodeIndexArgs): GenericCallView {
  return {
    card: 'generic',
    title: args.force === true ? 'CodeIndex rebuild (forced)' : 'CodeIndex refresh',
    kind: 'execute',
  }
}

/**
 * Completed-call presentation: a completed title; failures fall back to the
 * generic error rendering.
 *
 * @param _args - the raw tool arguments; unused, the view is argument-independent.
 * @param result - the final tool result; `isError` suppresses the view.
 * @returns the completed generic view, or `undefined` on failure.
 */
export function presentRefreshResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title: 'refresh_code_index' }
}

/**
 * Register `refresh_code_index`.
 *
 * @param ctx - the plugin context; execution resolves the optional `codeIndex` service through it.
 */
export function applyRefreshTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'refresh_code_index',
    description: 'Bring the local code index up to date with the current workspace (incrementally), or force a '
      + 'full rebuild. Concurrent passes fold into one commit; the epoch pair advances exactly once when it lands.',
    parameters: {
      force: {
        type: 'boolean',
        description: 'Rebuild from scratch instead of diffing (default false). Slower; use after schema-level doubt.',
      },
    },
    output: {
      // jscpd ignores this fixed-shape projection twin below.
      /* jscpd:ignore-start */
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', required: true },
          changedFiles: { type: 'integer', required: true },
          removedFiles: { type: 'integer', required: true },
          chunksWritten: { type: 'integer', required: true },
          durationMs: { type: 'integer', required: true },
          epochsAfter: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              indexEpoch: { type: 'integer', required: true },
              evidenceEpoch: { type: 'integer', required: true },
              embeddingEpoch: { type: 'integer' },
            },
          },
          explain: BUILD_EXPLAIN_SCHEMA,
        },
      },
      /* jscpd:ignore-end */
      render: (_args, value) => [{ type: 'text', text: renderRefreshOutput(value) }],
    },
    async execute(args, exec) {
      const workspace = await requireWorkspaceCodeIndex(ctx, 'refresh_code_index', exec)
      if (inFlightRefreshes.has(workspace.workspaceRoot)) {
        throw new CodeIndexToolError(
          'a code-index refresh is already in progress; retry once it completes',
          INDEX_TOOL_REFRESH_IN_PROGRESS,
        )
      }
      try {
        inFlightRefreshes.add(workspace.workspaceRoot)
        // Passthrough at the exit: the fixed-shape summary is naturally small.
        return await workspace.refresh({
          reason: 'manual',
          forceRebuild: args.force === true,
        })
      } catch (error) {
        throw normalizeCodeIndexFailure('refresh_code_index', error)
      } finally {
        inFlightRefreshes.delete(workspace.workspaceRoot)
      }
    },
    presentCall: presentRefreshCall,
    presentResult: presentRefreshResult,
  }))
}
