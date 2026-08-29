/**
 * The model-facing `search_code_index` tool over the optional
 * `ctx.codeIndex` seam: ranked chunk-level retrieval with self-explaining
 * score reasons. The canonical value is the complete `SearchResult`
 * (or its {@link OutputTruncationEnvelope} replacement once serialization
 * exceeded the tier's byte budget); Native rendering projects compact
 * `path:start-end score reasons` lines so routine answers stay far below
 * that budget.
 *
 * @module @relay-harness/rlh-tool-code-index/search-tool
 */

import type { Context } from '@relay-harness/cordis'
import { repoSizeTierMaxOutputChars } from '@relay-harness/rlh-code-index'
import type { SearchHit, SearchRequest, SearchResult } from '@relay-harness/rlh-code-index'
import type { ParserTier, RepoSizeTier } from '@relay-harness/rlh-code-index'
import { defineTool } from '@relay-harness/rlh-tools'
import type { GenericCallView, ToolExecution, ToolResult, ToolResultView } from '@relay-harness/rlh-tools'
import { applyExitPolicy } from './envelope.ts'
import type { OutputTruncationEnvelope } from './envelope.ts'
import { normalizeCodeIndexFailure, requireWorkspaceCodeIndex } from './errors.ts'

/** Schema-validated `search_code_index` arguments. */
export interface SearchCodeIndexArgs {
  query: string
  path_prefix?: string
  top_k?: number
  paths?: string[]
  recent_paths?: string[]
  include_grep?: boolean
}

/** Runtime knobs one registration of the search tool closes over. */
export interface SearchToolCaps {
  /** Drop an explicit `top_k` so the engine's repository-size-tier cap decides hit count. */
  clampTopKToTier: boolean
}

/** Mutable plain-data projection of one hit (lossless-JSON form, ready for the output schema). */
export interface SearchHitView {
  chunkId: string
  filePath: string
  language: string
  contentHash: string
  startLine: number
  endLine: number
  breadcrumb?: string
  symbolName?: string
  score: number
  /** Connectivity score from graph enrichment; absent without graph context. */
  graphScore?: number
  rank: number
  reasons: string[]
  scoreTrace: Array<{ label: string; value: number }>
  parserTier: ParserTier
  parserConfidence: number
}

/**
 * Canonical model-visible search output: the schema-projected plain-data form
 * of the seam's deeply-readonly `SearchResult`, or its truncation envelope.
 * JSON cloning at this boundary mirrors what the registry does anyway when it
 * snapshots a canonical value.
 */
export interface SearchToolResult {
  query: string
  tier: RepoSizeTier
  hits: SearchHitView[]
  candidateCount: number
  epochs: { indexEpoch: number; evidenceEpoch: number; embeddingEpoch?: number }
  truncated: boolean
  degraded: boolean
  readErrors: string[]
}

/** The two shapes `search_code_index` may return as its canonical value. */
export type SearchToolOutput = SearchToolResult | OutputTruncationEnvelope

/** Deep-plain clone turning the readonly seam answer into its lossless canonical form.
 *
 * @param result - the seam's deeply-readonly answer.
 * @returns the plain-data projection matching the output schema exactly.
 */
export function toPlainSearchResult(result: SearchResult): SearchToolResult {
  return JSON.parse(JSON.stringify(result)) as SearchToolResult
}

/** Detect an exit-truncation envelope in place of the raw result.
 *
 * @param value - any canonical value.
 * @returns whether narrowing to {@link OutputTruncationEnvelope} is sound.
 */
export function isTruncationEnvelope(value: unknown): value is OutputTruncationEnvelope {
  return typeof value === 'object' && value !== null && (value as { _truncated?: unknown })._truncated === true
}

/** Validate constraints the parameter schema cannot express; blank query or a non-positive `top_k` is an ordinary argument error.
 *
 * @param args - the schema-validated arguments.
 * @returns the accepted input, unchanged.
 */
export function parseSearchArgs(args: SearchCodeIndexArgs): SearchCodeIndexArgs {
  if (args.query.trim().length === 0) throw new Error('query must be a non-empty string')
  if (args.top_k !== undefined && (!Number.isInteger(args.top_k) || args.top_k < 1)) {
    throw new Error('top_k must be a positive integer')
  }
  return args
}

/**
 * Map validated arguments onto the seam's camelCase request vocabulary.
 * With `clampTopKToTier` set, an explicit `top_k` is dropped so the engine's
 * repository-size-tier cap decides hit count. `includeGrep: false` rides as an
 * advisory hint ahead of the seam field landing on `SearchRequest`.
 *
 * @param args - validated model arguments.
 * @param clampTopKToTier - whether the deployment removed the top-K lever.
 * @returns the seam request.
 */
export function toSearchRequest(
  args: SearchCodeIndexArgs,
  clampTopKToTier: boolean,
): SearchRequest & { includeGrep?: boolean } {
  return {
    query: args.query,
    ...(args.path_prefix !== undefined ? { pathPrefix: args.path_prefix } : {}),
    ...(!clampTopKToTier && args.top_k !== undefined ? { topK: args.top_k } : {}),
    ...(args.paths !== undefined ? { paths: args.paths } : {}),
    ...(args.recent_paths !== undefined ? { recentPaths: args.recent_paths } : {}),
    ...(args.include_grep === false ? { includeGrep: false } : {}),
  }
}

/** Render one hit as compact `path:start-end score reasons`.
 *
 * @param hit - one ranked hit from the seam answer.
 * @returns the single model-facing line.
 */
export function formatSearchHit(hit: SearchHit): string {
  return `${hit.filePath}:${hit.startLine}-${hit.endLine} ${hit.score} ${hit.reasons.join(',')}`
}

/**
 * Project a successful search outcome to the model-facing text. A complete
 * result renders a header, ranked hit lines, degradation notes, and a
 * candidate-count footer only when the ENGINE truncated ranking; an envelope
 * (serialization over budget) renders recovery prose instead and never unfolds
 * the partial payload back into context.
 *
 * @param value - the successful canonical value.
 * @returns the model-facing text.
 */
export function renderSearchOutput(value: SearchResult | SearchToolResult | OutputTruncationEnvelope): string {
  if (isTruncationEnvelope(value)) {
    return 'The code-index response was too large for one result '
      + `(${value._original_chars} bytes serialized against a ${value._max_chars}-byte budget); `
      + 'a bounded partial preview is attached for programmatic callers. Narrow path_prefix or top_k and retry.'
  }
  const lines: string[] = [`Query "${value.query}" (${value.tier} tier)`]
  if (value.hits.length === 0) {
    lines.push('No indexed chunks matched this query.')
  } else {
    for (const hit of value.hits) lines.push(formatSearchHit(hit))
  }
  if (value.readErrors.length > 0) {
    lines.push(`[degraded] ${value.readErrors.join('; ')} — treat these results as partial; do not cache.`)
  }
  if (value.truncated) {
    lines.push(`(showing ${value.hits.length} of ${value.candidateCount} candidates)`)
  }
  return lines.join('\n')
}

/**
 * Pending-call presentation: a generic search card titled by the query.
 *
 * @param args - the raw tool arguments; `query` feeds the title.
 * @returns the generic card view shown while the call runs.
 */
export function presentSearchCall(args: SearchCodeIndexArgs): GenericCallView {
  return { card: 'generic', title: `CodeIndex search: ${args.query}`, kind: 'search', rawInput: args.query }
}

/**
 * Completed-call presentation: keep the pending card under a completed title
 * derived purely from the arguments; failures fall back to generic error
 * rendering by returning `undefined`.
 *
 * @param args - the raw tool arguments; the title echoes the query.
 * @param result - the final tool result; `isError` suppresses the view.
 * @returns the completed generic view, or `undefined` on failure.
 */
export function presentSearchResult(args: SearchCodeIndexArgs, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title: `search_code_index · "${args.query}"` }
}

/** Resolve request arguments and execute one ranked retrieval against the loaded seam. */
async function runSearchQuery(
  ctx: Context,
  args: SearchCodeIndexArgs,
  caps: SearchToolCaps,
  exec: Readonly<ToolExecution>,
): Promise<SearchToolOutput> {
  const input = parseSearchArgs(args)
  const request = toSearchRequest(input, caps.clampTopKToTier)
  try {
    const workspace = await requireWorkspaceCodeIndex(ctx, 'search_code_index', exec)
    const result = await workspace.search(request, exec.signal)
    // Exit-side byte cap: the tier is read AFTER execution, from the answer
    // itself, mirroring the reference implementation's cached-tier semantics.
    return applyExitPolicy(toPlainSearchResult(result), 'byte-cap', repoSizeTierMaxOutputChars(result.tier))
  } catch (error) {
    throw normalizeCodeIndexFailure('search_code_index', error)
  }
}

/**
 * Register `search_code_index` under the given caps.
 *
 * @param ctx - the plugin context; execution resolves the optional `codeIndex` service through it.
 * @param caps - resolved runtime knobs (see `Config` in index.ts).
 */
export function applySearchTool(ctx: Context, caps: SearchToolCaps): void {
  const topKDescription = caps.clampTopKToTier
    ? 'Removed by this deployment: the engine always picks the hit count by repository size.'
    : 'Requested hit count (at least 1), capped again by the engine per repository size. '
      + 'Omit it to let the engine pick by repository-size tier.'
  ctx.tools.register(defineTool({
    name: 'search_code_index',
    description: 'Rank indexed workspace chunks against an identifier or free-word query. Every hit explains its '
      + 'score with reason tokens and carries file/line bounds for a follow-up read. Results are deterministic for '
      + 'an unchanged index epoch.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search text: identifier tokens, path fragments, and free words may be mixed.',
      },
      path_prefix: { type: 'string', description: 'Restrict candidates to file paths starting with this prefix.' },
      ...(caps.clampTopKToTier ? {} : { top_k: { type: 'integer', description: topKDescription } }),
      paths: { type: 'array', items: { type: 'string' }, description: 'Explicit scope: rank only these exact file paths.' },
      recent_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files you recently worked with; they receive a preselect-score boost.',
      },
      include_grep: {
        type: 'boolean',
        description: 'Include the exact-text grep lane in retrieval (default true). Providers may ignore the hint.',
      },
    },
    output: {
      // Lossless projection of SearchResult plus the exit-envelope branch;
      // the generated catalog carries the rendered form.
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true },
              tier: { type: 'string', required: true },
              hits: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    chunkId: { type: 'string', required: true },
                    filePath: { type: 'string', required: true },
                    language: { type: 'string', required: true },
                    contentHash: { type: 'string', required: true },
                    startLine: { type: 'integer', required: true },
                    endLine: { type: 'integer', required: true },
                    breadcrumb: { type: 'string' },
                    symbolName: { type: 'string' },
                    score: { type: 'number', required: true },
                    graphScore: { type: 'number' },
                    rank: { type: 'integer', required: true },
                    reasons: { type: 'array', required: true, items: { type: 'string' } },
                    scoreTrace: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          label: { type: 'string', required: true },
                          value: { type: 'number', required: true },
                        },
                      },
                    },
                    parserTier: { type: 'string', required: true },
                    parserConfidence: { type: 'number', required: true },
                  },
                },
              },
              candidateCount: { type: 'integer', required: true },
              epochs: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  indexEpoch: { type: 'integer', required: true },
                  evidenceEpoch: { type: 'integer', required: true },
                  embeddingEpoch: { type: 'integer' },
                },
              },
              truncated: { type: 'boolean', required: true },
              degraded: { type: 'boolean', required: true },
              readErrors: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              _truncated: { type: 'boolean', required: true, const: true },
              _original_chars: { type: 'integer', required: true },
              _max_chars: { type: 'integer', required: true },
              partial: { type: 'json', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchOutput(value as SearchToolOutput) }],
    },
    async execute(args, exec) {
      return runSearchQuery(ctx, args, caps, exec)
    },
    presentCall: presentSearchCall,
    presentResult: presentSearchResult,
  }))
}
