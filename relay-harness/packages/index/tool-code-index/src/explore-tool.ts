/**
 * The model-facing `explore_code_graph` tool over the optional `ctx.codeIndex`
 * seam: structured graph questions (`relations` / `impact` / `tests`) against
 * the derived call graph. The canonical value is the complete
 * `GraphExploreResult` (or its {@link OutputTruncationEnvelope} replacement
 * once serialization exceeded the tier's byte budget); Native rendering
 * projects compact node/edge/test lines plus an explain summary so routine
 * answers stay far below that budget.
 *
 * @module @relay-harness/rlh-tool-code-index/explore-tool
 */

import type { Context } from '@relay-harness/cordis'
import { repoSizeTierMaxOutputChars } from '@relay-harness/rlh-code-index'
import type { GraphExploreRequest, GraphExploreResult } from '@relay-harness/rlh-code-index'
import { defineTool } from '@relay-harness/rlh-tools'
import type { GenericCallView, ToolExecution, ToolResult, ToolResultView } from '@relay-harness/rlh-tools'
import { applyExitPolicy } from './envelope.ts'
import type { OutputTruncationEnvelope } from './envelope.ts'
import { normalizeCodeIndexFailure, requireWorkspaceCodeIndex } from './errors.ts'
import { isTruncationEnvelope } from './search-tool.ts'

/** The five graph questions `explore_code_graph` can ask. */
export type ExploreCodeGraphOp = 'relations' | 'impact' | 'tests' | 'cycles' | 'dead_code'

/** Schema-validated `explore_code_graph` arguments (flat, `op`-discriminated). */
export interface ExploreCodeGraphArgs {
  /** Which graph question to ask. */
  op: ExploreCodeGraphOp
  /** `relations`/`impact`: symbol name to resolve. */
  symbol?: string
  /** `relations`: pin the symbol to this file when several declarations share the name. */
  file_path?: string
  /** `relations`: which side to walk (default `both`). */
  direction?: 'callers' | 'callees' | 'both'
  /** `relations`: walk depth, 1 or 2 (default 1). */
  depth?: number
  /** `impact`/`tests`: code files anchoring the question. */
  files?: string[]
  /** `impact`: whether impacted tests join the answer (default true). */
  include_tests?: boolean
  /** Rendered-node cap (`relations`/`impact`), test-pair cap (`tests`), cycle-component cap (`cycles`), or item cap (`dead_code`). */
  max?: number
}

/** Mutable plain-data projection of one graph node (lossless-JSON form, ready for the output schema). */
export interface GraphToolNodeView {
  nodeId: string
  name: string
  kind: string
  filePath: string
  startLine: number
  role?: string
}

/** Mutable plain-data projection of one graph edge. */
export interface GraphToolEdgeView {
  edgeId: string
  kind: string
  source: string
  target: string
  line?: number
  callKind?: string
  resolutionStrategy?: string
  confidence: number
  reason?: string
}

/** Mutable plain-data projection of one test-to-code association. */
export interface GraphToolTestPairView {
  testFilePath: string
  codeFilePath: string
  reason: string
  confidence: number
}

/** Mutable plain-data projection of one circular-dependency component. */
export interface GraphToolCycleView {
  id: string
  size: number
  severity: string
  memberIds: string[]
  witnessEdges: Array<{ from: string; to: string; importString: string }>
}

/** Mutable plain-data projection of one dead-code candidate. */
export interface GraphToolDeadCodeView {
  symbolName: string
  symbolId: string
  filePath: string
  kind: string
  reason: string
}

/** Mutable plain-data projection of the seam answer's explain envelope. */
export interface GraphToolExplainView {
  declared: string[]
  readErrors: string[]
  droppedReadErrorCount: number
  truncatedReason?: string
}

/**
 * Canonical model-visible explore output: the schema-projected plain-data form
 * of the seam's deeply-readonly `GraphExploreResult`. JSON cloning at this
 * boundary mirrors what the registry does anyway when it snapshots a canonical
 * value.
 */
export interface GraphToolResult {
  op: string
  indexEpoch: { indexEpoch: number; evidenceEpoch: number; embeddingEpoch?: number }
  nodes: GraphToolNodeView[]
  edges: GraphToolEdgeView[]
  tests?: GraphToolTestPairView[]
  cycles?: GraphToolCycleView[]
  deadCode?: GraphToolDeadCodeView[]
  explain: GraphToolExplainView
  truncated: boolean
  candidateCount: number
  tier: string
}

/** The two shapes `explore_code_graph` may return as its canonical value. */
export type ExploreToolOutput = GraphToolResult | OutputTruncationEnvelope

/** Non-blank-string argument guard shared by every op.
 *
 * @param value - the argument value.
 * @param name - argument name for the error message.
 * @returns the value, verified non-blank.
 */
function requireNonBlank(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

/** Hard upper bound on the model-requested `max` cap, so no single explore
 * answer can size its scan budget unreasonably. */
const MAX_ALLOWED_MAX = 10_000

/** Shared positive-integer guard for the `max` cap.
 *
 * @param value - the `max` argument value, when present.
 * @returns the value, verified a positive integer within the 10 000 ceiling.
 */
function requirePositiveMax(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) throw new Error('max must be a positive integer')
  if (value > MAX_ALLOWED_MAX) throw new Error(`max must not exceed ${MAX_ALLOWED_MAX}`)
  return value
}

/** Throw when an op-specific argument rides on an op that does not take it.
 *
 * @param args - the schema-validated arguments.
 * @param keys - argument names that are illegal on the calling op.
 * @param appliesTo - the ops that DO take the arguments, for the error message.
 */
function rejectExclusive(args: ExploreCodeGraphArgs, keys: readonly (keyof ExploreCodeGraphArgs)[], appliesTo: string): void {
  for (const key of keys) {
    if (args[key] !== undefined) throw new Error(`${key} only applies to ${appliesTo}`)
  }
}

/** Validate constraints the parameter schema cannot express; cross-op illegal combinations are ordinary argument errors.
 *
 * @param args - the schema-validated arguments.
 * @returns the accepted input, unchanged.
 */
export function parseExploreArgs(args: ExploreCodeGraphArgs): ExploreCodeGraphArgs {
  requirePositiveMax(args.max)
  switch (args.op) {
    case 'relations': {
      requireNonBlank(args.symbol, 'symbol')
      if (args.file_path !== undefined) requireNonBlank(args.file_path, 'file_path')
      if (args.depth !== undefined && (!Number.isInteger(args.depth) || args.depth < 1 || args.depth > 2)) {
        throw new Error('depth must be 1 or 2')
      }
      if (args.direction !== undefined && !['callers', 'callees', 'both'].includes(args.direction)) {
        throw new Error('direction must be callers, callees, or both')
      }
      rejectExclusive(args, ['files', 'include_tests'], 'op=relations')
      return args
    }
    case 'impact': {
      if (args.symbol === undefined && (args.files === undefined || args.files.length === 0)) {
        throw new Error('op=impact requires symbol or files')
      }
      if (args.symbol !== undefined) requireNonBlank(args.symbol, 'symbol')
      if (args.files !== undefined) {
        if (args.files.length === 0 || args.files.some(file => typeof file !== 'string' || file.trim().length === 0)) {
          throw new Error('files must be a non-empty list of non-empty strings')
        }
      }
      rejectExclusive(args, ['direction', 'depth', 'file_path'], 'op=relations')
      return args
    }
    case 'tests': {
      if (args.files === undefined || args.files.length === 0 || args.files.some(file => typeof file !== 'string' || file.trim().length === 0)) {
        throw new Error('op=tests requires files: a non-empty list of non-empty strings')
      }
      rejectExclusive(args, ['direction', 'depth', 'file_path', 'include_tests'], 'op=relations')
      if (args.symbol !== undefined) throw new Error('symbol only applies to op=relations or op=impact')
      return args
    }
    case 'cycles':
    case 'dead_code': {
      rejectExclusive(
        args,
        ['symbol', 'file_path', 'direction', 'depth', 'files', 'include_tests'],
        'op=relations, impact, or tests',
      )
      return args
    }
  }
}

/**
 * Map validated arguments onto the seam's camelCase discriminated union.
 * `include_tests` rides only when explicitly false (the seam default is true).
 *
 * @param args - validated model arguments.
 * @returns the seam graph-explore request.
 */
export function toExploreRequest(args: ExploreCodeGraphArgs): GraphExploreRequest {
  switch (args.op) {
    case 'relations':
      return {
        op: 'relations',
        symbol: args.symbol as string,
        ...(args.file_path !== undefined ? { filePath: args.file_path } : {}),
        ...(args.direction !== undefined ? { direction: args.direction } : {}),
        ...(args.depth !== undefined ? { depth: args.depth === 2 ? 2 : 1 } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
      }
    case 'impact':
      return {
        op: 'impact',
        ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
        ...(args.files !== undefined ? { files: [...args.files] } : {}),
        ...(args.include_tests === false ? { includeTests: false } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
      }
    case 'tests':
      return {
        op: 'tests',
        files: [...(args.files as string[])],
        ...(args.max !== undefined ? { max: args.max } : {}),
      }
    case 'cycles':
      return {
        op: 'cycles',
        ...(args.max !== undefined ? { max: args.max } : {}),
      }
    case 'dead_code':
      return {
        op: 'dead_code',
        ...(args.max !== undefined ? { max: args.max } : {}),
      }
  }
}

/** Deep-plain clone turning the readonly seam answer into its lossless canonical form.
 *
 * @param result - the seam's deeply-readonly answer.
 * @returns the plain-data projection matching the output schema exactly.
 */
export function toPlainGraphResult(result: GraphExploreResult): GraphToolResult {
  return JSON.parse(JSON.stringify(result)) as GraphToolResult
}

/** Render one node as compact `role kind name @ file:start`.
 *
 * @param node - one node from the seam answer.
 * @returns the single model-facing line.
 */
export function formatGraphNode(node: GraphToolNodeView): string {
  const role = node.role === undefined ? '' : `${node.role} `
  return `${role}${node.kind} ${node.name} @ ${node.filePath}:${node.startLine}`
}

/** Render one edge as the enrichment's `caller: X → Y (f:line)` template.
 *
 * @param edge - one edge from the seam answer.
 * @param names - node-id → name lookup rendered from the answer's nodes.
 * @returns the single model-facing line.
 */
export function formatGraphEdge(edge: GraphToolEdgeView, names: ReadonlyMap<string, string>): string {
  const source = names.get(edge.source) ?? edge.source
  const target = names.get(edge.target) ?? edge.target
  const site = edge.reason ?? `line ${edge.line ?? 0}`
  return `caller: ${source} → ${target} (${site})`
}

/** Render one test pair as `test: spec → code (reason)`.
 *
 * @param pair - one test association from the seam answer.
 * @returns the single model-facing line.
 */
export function formatTestPair(pair: GraphToolTestPairView): string {
  return `test: ${pair.testFilePath} → ${pair.codeFilePath} (${pair.reason})`
}

/** Render one cycle component as `size n: a → b → c`.
 *
 * @param component - one circular-dependency component from the seam answer.
 * @returns the single model-facing line.
 */
export function formatCycleComponent(component: GraphToolCycleView): string {
  return `size ${component.size}: ${component.memberIds.join(' → ')}`
}

/** Render one dead-code candidate as `dead: kind name @ file (reason)`.
 *
 * @param item - one dead-code candidate from the seam answer.
 * @returns the single model-facing line.
 */
export function formatDeadCode(item: GraphToolDeadCodeView): string {
  return `dead: ${item.kind} ${item.symbolName} @ ${item.filePath} (${item.reason})`
}

/**
 * Project a successful explore outcome to the model-facing text. A complete
 * answer renders an op header, node/edge/test lines, degradation notes, an
 * explain summary, and a truncation footer only when a cap cut the answer; an
 * envelope (serialization over budget) renders recovery prose instead and
 * never unfolds the partial payload back into context.
 *
 * @param value - the successful canonical value.
 * @returns the model-facing text.
 */
export function renderExploreOutput(value: ExploreToolOutput): string {
  if (isTruncationEnvelope(value)) {
    return 'The code-index graph response was too large for one result '
      + `(${value._original_chars} bytes serialized against a ${value._max_chars}-byte budget); `
      + 'a bounded partial preview is attached for programmatic callers. Narrow max or the queried symbol/files and retry.'
  }
  const lines: string[] = [`${value.op} explore (${value.tier} tier)`]
  const names = new Map(value.nodes.map(node => [node.nodeId, node.name]))
  const emptyAnalysis = (value.cycles === undefined || value.cycles.length === 0)
    && (value.deadCode === undefined || value.deadCode.length === 0)
  if (value.nodes.length === 0 && value.edges.length === 0 && (value.tests === undefined || value.tests.length === 0) && emptyAnalysis) {
    lines.push('No graph entries matched this question.')
  }
  for (const node of value.nodes) lines.push(formatGraphNode(node))
  for (const edge of value.edges) lines.push(formatGraphEdge(edge, names))
  for (const pair of value.tests ?? []) lines.push(formatTestPair(pair))
  for (const component of value.cycles ?? []) lines.push(formatCycleComponent(component))
  for (const item of value.deadCode ?? []) lines.push(formatDeadCode(item))
  if (value.explain.readErrors.length > 0) {
    lines.push(`[degraded] ${value.explain.readErrors.join('; ')}`)
  }
  lines.push(`explain: declared=[${value.explain.declared.join(',')}] candidates=${value.candidateCount}`)
  if (value.truncated) {
    const reason = value.explain.truncatedReason ?? 'unknown'
    lines.push(`(truncated: ${reason}; ${value.candidateCount} candidates considered)`)
  }
  return lines.join('\n')
}

/**
 * Pending-call presentation: a generic card titled by the op (and symbol when
 * the question names one).
 *
 * @param args - the raw tool arguments; `op`/`symbol` feed the title.
 * @returns the generic card view shown while the call runs.
 */
export function presentExploreCall(args: ExploreCodeGraphArgs): GenericCallView {
  const subject = args.symbol !== undefined ? `: ${args.symbol}` : ''
  return { card: 'generic', title: `CodeIndex graph: ${args.op}${subject}`, kind: 'search', rawInput: args.symbol ?? args.files?.join(', ') }
}

/**
 * Completed-call presentation: keep the pending card under a completed title
 * derived purely from the arguments; failures fall back to generic error
 * rendering by returning `undefined`.
 *
 * @param args - the raw tool arguments; the title echoes op and symbol.
 * @param result - the final tool result; `isError` suppresses the view.
 * @returns the completed generic view, or `undefined` on failure.
 */
export function presentExploreResult(args: ExploreCodeGraphArgs, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  const subject = args.symbol !== undefined ? ` ${args.symbol}` : ''
  return { card: 'generic', title: `explore_code_graph · ${args.op}${subject}` }
}

/** Resolve request arguments and execute one graph question against the loaded seam. */
async function runExploreQuery(
  ctx: Context,
  args: ExploreCodeGraphArgs,
  exec: Readonly<ToolExecution>,
): Promise<ExploreToolOutput> {
  const input = parseExploreArgs(args)
  try {
    const workspace = await requireWorkspaceCodeIndex(ctx, 'explore_code_graph', exec)
    const result = await workspace.exploreGraph(toExploreRequest(input), exec.signal)
    // Exit-side byte cap: the tier is read AFTER execution, from the answer
    // itself, mirroring the search tool's cached-tier semantics.
    return applyExitPolicy(toPlainGraphResult(result), 'byte-cap', repoSizeTierMaxOutputChars(result.tier))
  } catch (error) {
    throw normalizeCodeIndexFailure('explore_code_graph', error)
  }
}

/**
 * Register `explore_code_graph`.
 *
 * @param ctx - the plugin context; execution resolves the optional `codeIndex` service through it.
 */
export function applyExploreTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'explore_code_graph',
    description: 'Answer structured questions over the workspace code graph. op=relations walks the callers and/or '
      + 'callees of one symbol; op=impact sweeps what reverse reachability breaks for a symbol or file set, with the '
      + 'impacted tests attached; op=tests maps code files to the tests exercising them; op=cycles detects circular '
      + 'file-import cycles; op=dead_code lists symbols with no callers or references. Answers carry the matching '
      + 'view plus an explain block under the index epoch they were read at.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['relations', 'impact', 'tests', 'cycles', 'dead_code'],
        description: 'Which question to ask: relations (callers/callees of one symbol), impact (reverse reachability '
          + 'plus impacted tests), tests (files → covering tests), cycles (circular import components, largest first), '
          + 'or dead_code (symbols with no callers or external references).',
      },
      symbol: {
        type: 'string',
        description: 'Symbol name to resolve. Required for op=relations; optional seed for op=impact.',
      },
      file_path: {
        type: 'string',
        description: 'relations only: pin the symbol to this file when several declarations share the name.',
      },
      direction: {
        type: 'string',
        enum: ['callers', 'callees', 'both'],
        description: 'relations only: which side to walk. Defaults to both.',
      },
      depth: {
        type: 'integer',
        description: 'relations only: walk depth, 1 or 2. Defaults to 1.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative code files. Required for op=tests; optional seeds for op=impact.',
      },
      include_tests: {
        type: 'boolean',
        description: 'impact only: attach the impacted tests (default true).',
      },
      max: {
        type: 'integer',
        description: 'Cap on rendered nodes (relations/impact), returned test pairs (tests), cycle components '
          + '(cycles), or reported symbols (dead_code). Positive integer, at most 10000.',
      },
    },
    output: {
      // Lossless projection of GraphExploreResult plus the exit-envelope branch;
      // the generated catalog carries the rendered form.
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', required: true },
              indexEpoch: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  indexEpoch: { type: 'integer', required: true },
                  evidenceEpoch: { type: 'integer', required: true },
                  embeddingEpoch: { type: 'integer' },
                },
              },
              nodes: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    nodeId: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    filePath: { type: 'string', required: true },
                    startLine: { type: 'integer', required: true },
                    role: { type: 'string' },
                  },
                },
              },
              edges: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    edgeId: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    source: { type: 'string', required: true },
                    target: { type: 'string', required: true },
                    line: { type: 'integer' },
                    callKind: { type: 'string' },
                    resolutionStrategy: { type: 'string' },
                    confidence: { type: 'number', required: true },
                    reason: { type: 'string' },
                  },
                },
              },
              tests: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    testFilePath: { type: 'string', required: true },
                    codeFilePath: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                    confidence: { type: 'number', required: true },
                  },
                },
              },
              cycles: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    size: { type: 'integer', required: true },
                    severity: { type: 'string', required: true },
                    memberIds: { type: 'array', required: true, items: { type: 'string' } },
                    witnessEdges: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          from: { type: 'string', required: true },
                          to: { type: 'string', required: true },
                          importString: { type: 'string', required: true },
                        },
                      },
                    },
                  },
                },
              },
              deadCode: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    symbolName: { type: 'string', required: true },
                    symbolId: { type: 'string', required: true },
                    filePath: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                  },
                },
              },
              explain: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  declared: { type: 'array', required: true, items: { type: 'string' } },
                  readErrors: { type: 'array', required: true, items: { type: 'string' } },
                  droppedReadErrorCount: { type: 'integer', required: true },
                  truncatedReason: { type: 'string' },
                },
              },
              truncated: { type: 'boolean', required: true },
              candidateCount: { type: 'integer', required: true },
              tier: { type: 'string', required: true },
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
      render: (_args, value) => [{ type: 'text', text: renderExploreOutput(value) }],
    },
    async execute(args, exec) {
      return runExploreQuery(ctx, args, exec)
    },
    presentCall: presentExploreCall,
    presentResult: presentExploreResult,
  }))
}
