/**
 * The model-facing `code_index_status` tool over the optional `ctx.codeIndex`
 * seam: a zero-argument health report whose canonical value is the seam's
 * naturally bounded {@link IndexStatusReport}, shipped through the exit
 * policy as `passthrough` (its shape is fixed and small by construction).
 *
 * @module @relay-harness/rlh-tool-code-index/status-tool
 */

import type { Context } from '@relay-harness/cordis'
import type { RefreshSummary } from '@relay-harness/rlh-code-index'
import { defineTool } from '@relay-harness/rlh-tools'
import type { GenericCallView, ToolResult, ToolResultView } from '@relay-harness/rlh-tools'
import { normalizeCodeIndexFailure, requireCodeIndex } from './errors.ts'

/** Loose projection input: every label the seam types as a union is taken at its string width. */
export interface StatusReportView {
  indexedFileCount: number
  tier: string
  epochs: { indexEpoch: number; evidenceEpoch: number }
  degraded: boolean
  lastRefresh?: Omit<RefreshSummary, 'reason'> & { reason: string }
}

/**
 * Render one status report as deterministic `key: value` lines.
 *
 * @param report - the seam's health snapshot (or its schema-projected form).
 * @returns the model-facing text.
 */
export function renderStatusOutput(report: StatusReportView): string {
  const lines: string[] = [
    `indexedFileCount: ${report.indexedFileCount}`,
    `tier: ${report.tier}`,
    `indexEpoch: ${report.epochs.indexEpoch}`,
    `evidenceEpoch: ${report.epochs.evidenceEpoch}`,
    `degraded: ${report.degraded}`,
  ]
  if (report.lastRefresh === undefined) {
    lines.push('lastRefresh: none')
  } else {
    const last = report.lastRefresh
    lines.push(
      `lastRefresh: reason=${last.reason} changedFiles=${last.changedFiles} removedFiles=${last.removedFiles} `
      + `chunksWritten=${last.chunksWritten} durationMs=${last.durationMs} epochsAfter(index=${last.epochsAfter.indexEpoch}, `
      + `evidence=${last.epochsAfter.evidenceEpoch})`,
    )
  }
  return lines.join('\n')
}

/**
 * Pending-call presentation: a plain titled card.
 *
 * @returns the generic card view shown while the call runs.
 */
export function presentStatusCall(): GenericCallView {
  return { card: 'generic', title: 'CodeIndex status', kind: 'read' }
}

/**
 * Completed-call presentation: a completed title; failures fall back to the
 * generic error rendering.
 *
 * @param _args - the raw tool arguments; unused, the view is argument-independent.
 * @param result - the final tool result; `isError` suppresses the view.
 * @returns the completed generic view, or `undefined` on failure.
 */
export function presentStatusResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title: 'code_index_status' }
}

/**
 * Register `code_index_status`.
 *
 * @param ctx - the plugin context; execution resolves the optional `codeIndex` service through it.
 */
export function applyStatusTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'code_index_status',
    description: 'Report local code-index health without side effects: indexed file count, repository-size tier, '
      + 'current epoch pair, last refresh summary, and degradation flag.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          indexedFileCount: { type: 'integer', required: true },
          tier: { type: 'string', required: true },
          epochs: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              indexEpoch: { type: 'integer', required: true },
              evidenceEpoch: { type: 'integer', required: true },
            },
          },
          lastRefresh: {
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
                },
              },
            },
          },
          degraded: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatusOutput(value) }],
    },
    async execute() {
      try {
        // Passthrough at the exit: the fixed-shape report is naturally small.
        return await requireCodeIndex(ctx, 'code_index_status').status()
      } catch (error) {
        throw normalizeCodeIndexFailure('code_index_status', error)
      }
    },
    presentCall: presentStatusCall,
    presentResult: presentStatusResult,
  }))
}
