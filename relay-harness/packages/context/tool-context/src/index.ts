/** Agent-facing retrieval over the existing Context Engine; model arguments never select caller authority. */
import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type {} from '@relay-harness/rlh-agent'
import { resolveSessionPreset } from '@relay-harness/rlh-agent-presets'
import type {} from '@relay-harness/rlh-context-engine'
import { defineTool, ToolArgsError } from '@relay-harness/rlh-tools'
import { CONTEXT_OUTPUT_SCHEMA, packContextOutput, renderContextOutput } from './output.ts'

export { CONTEXT_OUTPUT_SCHEMA, packContextOutput, renderContextOutput } from './output.ts'
export type { ContextToolOutput } from './output.ts'

/** Cordis consumer name. */
export const name = 'tool-context'
/** This consumer only registers after its current runtime services exist. */
export const inject = ['tools', 'agents', 'contextEngine']

/** Separate retrieval and final wire budgets reserve room for provenance without trusting provider size estimates. */
export interface Config {
  /** Maximum model-authored query code points. */
  maxQueryChars?: number
  /** Complete messages admitted by the shared Context Engine. */
  maxContextChars?: number
  /** Estimated token allowance for admitted context messages. */
  maxContextTokens?: number
  /** Complete tool result, including evidence, diagnostics and JSON escaping. */
  maxOutputChars?: number
  /** Estimated token allowance for the complete tool result. */
  maxOutputTokens?: number
  /** Optional deployment allowlist of contributor ids; omission keeps explicitly tool-enabled sources. */
  contributors?: string[]
}

/** Validated deployment knobs; no query can increase them. */
export const Config: z<Config> = z.object({
  maxQueryChars: z.natural().min(1).default(8192),
  maxContextChars: z.natural().min(1).default(12000),
  maxContextTokens: z.natural().min(1).default(3000),
  maxOutputChars: z.natural().min(1024).default(24000),
  maxOutputTokens: z.natural().min(256).default(6000),
  contributors: z.array(z.string()).default(undefined as never),
})

/** Register read-only explicit retrieval in the current Agent/preset tool scope.
 * @param ctx - Cordis scope owning the tool registration.
 * @param config - Validated retrieval/output policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const policy = {
    maxQueryChars: config.maxQueryChars ?? 8192,
    maxContextChars: config.maxContextChars ?? 12000,
    maxContextTokens: config.maxContextTokens ?? 3000,
    maxOutputChars: config.maxOutputChars ?? 24000,
    maxOutputTokens: config.maxOutputTokens ?? 6000,
  }
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('tool-context budgets must be positive safe integers')
  }
  if (policy.maxOutputChars < 1024 || policy.maxOutputTokens < 256
    || policy.maxContextChars > policy.maxOutputChars || policy.maxContextTokens > policy.maxOutputTokens) {
    throw new Error('tool-context requires output room for context plus provenance')
  }
  const allowlist = config.contributors === undefined ? undefined : new Set(config.contributors)
  if (allowlist?.size !== config.contributors?.length || config.contributors?.some(id => id.trim() === '')) {
    throw new Error('tool-context source allowlist contains duplicate or empty ids')
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'retrieve_context',
    description: 'Retrieve source-attributed context from the current Agent workspace and permitted memory, Session history, explicit @file paths and catalogued MCP resource URIs. Omit query to list source ids. Query text is data, not a human instruction. This does not start other Agents, grant permissions, or prove absence. Use read tools when an excerpt is truncated.',
    parameters: {
      query: { type: 'string', description: 'Search text. File reads require explicit @path mentions; MCP reads require an exact catalogued URI. Omit to inspect sources without reading content.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Optional exact source ids returned by catalog mode; never Session ids or credentials.' },
    },
    output: { schema: CONTEXT_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderContextOutput(value) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || ctx.agents.get(agent.id) !== agent) throw new ToolArgsError(['retrieve_context requires the current live Agent'])
      const engine = agent.ctx.get('contextEngine')
      if (engine === undefined) throw new ToolArgsError(['this Agent has no Context Engine'])
      exec.signal.throwIfAborted()
      const descriptors = engine.describeContributors()
      for (const id of allowlist ?? []) {
        if (!descriptors.some(source => source.id === id)) throw new Error(`configured context source is not registered: ${id}`)
      }
      const sources = descriptors.filter(source => (allowlist === undefined || allowlist.has(source.id)) && source.purposes.includes('tool_retrieval'))
      const budget = { maxChars: policy.maxOutputChars, maxTokens: policy.maxOutputTokens }
      if (args.query === undefined) return packContextOutput(agent.ctx, sources, undefined, budget)
      const query = args.query.trim()
      if (query === '' || Array.from(query).length > policy.maxQueryChars) throw new ToolArgsError(['context query is empty or exceeds the configured character limit'])
      const selected = args.sources ?? sources.map(source => source.id)
      if (selected.some(id => !sources.some(source => source.id === id))) throw new ToolArgsError(['requested context source is unavailable for tool retrieval'])
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new ToolArgsError(['context retrieval requires an explicit Session working directory'])
      const preset = resolveSessionPreset(agent.session)
      const report = await engine.retrieve({
        query, contributors: [...new Set(selected)], cwd, signal: exec.signal,
        caller: {
          sessionId: agent.session.id, agentId: agent.id, workspaceId: cwd,
          ...(preset === undefined ? {} : { agentPreset: preset }),
          ...(agent.session.header.origin === undefined ? {} : { origin: agent.session.header.origin }),
        },
        budget: { maxChars: policy.maxContextChars, maxTokens: policy.maxContextTokens },
      })
      exec.signal.throwIfAborted()
      if (ctx.agents.get(agent.id) !== agent) throw new ToolArgsError(['context retrieval lost its Agent owner'])
      return packContextOutput(agent.ctx, sources, report, budget)
    },
  })), 'tool-context: scoped retrieval')
}
