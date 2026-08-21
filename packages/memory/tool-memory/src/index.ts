/**
 * Model-facing long-term-memory search and governed write tools.
 *
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryId } from '@deepseek-ai/dsh-memory'
import type {
  MemoryEvidence,
  MemoryScope,
  MemoryTrust,
} from '@deepseek-ai/dsh-memory/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'tool-memory'
export const inject = ['longTermMemory', 'tools']

const MEMORY_KINDS = ['preference', 'fact', 'constraint', 'decision', 'procedure', 'lesson'] as const
const SEARCH_STATUSES = ['active', 'candidate', 'disputed'] as const
const DEFAULT_USER_ID = 'local'
const DEFAULT_AGENT_ID = 'deepseek-harness'
const DEFAULT_SEARCH_LIMIT = 10

/** Model-facing memory-tool configuration. */
export interface Config {
  /** Stable user identity inside each workspace. Defaults to `local`. */
  userId?: string
  /** Stable Agent identity shared across recallable sessions. Defaults to `deepseek-harness`. */
  agentId?: string
  /** Explicit workspace identity; omission uses the calling session cwd, then `global`. */
  workspaceId?: string
  /** Default `memory_search` result cap; from 1 through 50. Defaults to 10. */
  defaultSearchLimit?: number
}

/** Validate and default memory-tool configuration. */
export const Config: z<Config> = z.object({
  userId: z.string().default(DEFAULT_USER_ID),
  agentId: z.string().default(DEFAULT_AGENT_ID),
  workspaceId: z.string(),
  defaultSearchLimit: z.number().step(1).min(1).max(50).default(DEFAULT_SEARCH_LIMIT),
})

interface ResolvedConfig {
  userId: string
  agentId: string
  workspaceId?: string
  defaultSearchLimit: number
}

/** Register provider-neutral memory tools. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const textOutput = {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search durable cross-session memory in the current user, workspace, and agent scope. Use a specific query; results include compact content and exact memory ids for memory_read.',
    parameters: {
      query: { type: 'string', required: true, description: 'Specific words or sentence to retrieve.' },
      limit: { type: 'integer', description: `Maximum results; defaults to ${resolved.defaultSearchLimit}.` },
      kinds: {
        type: 'array',
        description: 'Optional memory kinds to include.',
        items: { type: 'string', enum: [...MEMORY_KINDS] },
      },
      statuses: {
        type: 'array',
        description: 'Optional governance states; defaults to active only.',
        items: { type: 'string', enum: [...SEARCH_STATUSES] },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scope = memoryScope(agent, resolved)
      const hits = await ctx.longTermMemory.search({
        scope,
        query: args.query,
        limit: args.limit ?? resolved.defaultSearchLimit,
        ...args.kinds === undefined ? {} : { kinds: args.kinds },
        ...args.statuses === undefined ? {} : { statuses: args.statuses },
      }, exec.signal)
      return JSON.stringify(hits.map(hit => ({
        id: hit.entry.id,
        revision: hit.entry.revision,
        kind: hit.entry.kind,
        status: hit.entry.status,
        trust: hit.entry.trust,
        confidence: hit.entry.confidence,
        importance: hit.entry.importance,
        updatedAt: hit.entry.updatedAt,
        score: hit.score,
        matchedBy: hit.matchedBy,
        content: compact(hit.entry.summary ?? hit.entry.content, 320),
      })), null, 2)
    },
    presentCall: args => ({ card: 'generic', title: 'Search memory', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one complete current memory entry by an exact id returned by memory_search.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id.' },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const entry = await ctx.longTermMemory.read(
        memoryScope(requireAgent(exec), resolved),
        MemoryId(args.id),
        exec.signal,
      )
      if (entry === undefined) throw new Error(`memory ${args.id} was not found in the current scope`)
      return JSON.stringify(entry, null, 2)
    },
    presentCall: args => ({ card: 'generic', title: 'Read memory', kind: 'search', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Propose one durable memory. Provide an exact evidence_quote from a direct user message or successful tool result to activate it; without verified evidence it remains a candidate and is not proactively recalled.',
    parameters: {
      kind: { type: 'string', required: true, enum: [...MEMORY_KINDS], description: 'Semantic memory kind.' },
      content: { type: 'string', required: true, description: 'One stable, self-contained fact, preference, constraint, decision, procedure, or lesson.' },
      summary: { type: 'string', description: 'Optional shorter retrieval label.' },
      importance: { type: 'integer', required: true, description: '1 minor through 4 critical.' },
      evidence_quote: { type: 'string', description: 'Exact excerpt from a direct user message or successful tool result in this session.' },
    },
    output: textOutput,
    resourceIntents: (_args, exec) => [memoryIntent(requireAgent(exec), resolved, 'write')],
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const verified = args.evidence_quote === undefined
        ? proposalEvidence(agent, exec)
        : verifiedEvidence(agent, args.evidence_quote)
      const entry = await ctx.longTermMemory.remember({
        scope: memoryScope(agent, resolved),
        kind: args.kind,
        content: args.content,
        ...args.summary === undefined ? {} : { summary: args.summary },
        importance: args.importance,
        confidence: verified.trust === 'agent-proposed' ? 0.5 : 1,
        trust: verified.trust,
        status: verified.trust === 'agent-proposed' ? 'candidate' : 'active',
        evidence: [verified.evidence],
      }, exec.signal)
      return JSON.stringify(entry, null, 2)
    },
    presentCall: args => ({ card: 'generic', title: 'Remember', kind: 'other', rawInput: args.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: 'Append a new revision of one memory. Content changes or activation require an exact evidence_quote; unverified content changes are downgraded to candidate state.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id.' },
      content: { type: 'string', description: 'Replacement content.' },
      summary: { type: 'string', description: 'Replacement summary.' },
      importance: { type: 'integer', description: '1 minor through 4 critical.' },
      confidence: { type: 'number', description: 'Confidence from 0 through 1.' },
      status: { type: 'string', enum: [...SEARCH_STATUSES], description: 'Replacement governance state.' },
      evidence_quote: { type: 'string', description: 'Exact supporting excerpt for content changes or activation.' },
    },
    output: textOutput,
    resourceIntents: (_args, exec) => [memoryIntent(requireAgent(exec), resolved, 'write')],
    async execute(args, exec) {
      const agent = requireAgent(exec)
      if (args.content === undefined && args.summary === undefined && args.importance === undefined
        && args.confidence === undefined && args.status === undefined) {
        throw new Error('memory_update requires at least one changed field')
      }
      if ((args.content !== undefined || args.status === 'active') && args.evidence_quote === undefined) {
        const proposed = proposalEvidence(agent, exec)
        const entry = await ctx.longTermMemory.revise({
          scope: memoryScope(agent, resolved),
          id: MemoryId(args.id),
          ...args.content === undefined ? {} : { content: args.content },
          ...args.summary === undefined ? {} : { summary: args.summary },
          ...args.importance === undefined ? {} : { importance: args.importance },
          ...args.confidence === undefined ? {} : { confidence: args.confidence },
          trust: 'agent-proposed',
          status: 'candidate',
          evidence: [proposed.evidence],
        }, exec.signal)
        return JSON.stringify(entry, null, 2)
      }
      const evidence = args.evidence_quote === undefined
        ? proposalEvidence(agent, exec)
        : verifiedEvidence(agent, args.evidence_quote)
      const entry = await ctx.longTermMemory.revise({
        scope: memoryScope(agent, resolved),
        id: MemoryId(args.id),
        ...args.content === undefined ? {} : { content: args.content },
        ...args.summary === undefined ? {} : { summary: args.summary },
        ...args.importance === undefined ? {} : { importance: args.importance },
        ...args.confidence === undefined ? {} : { confidence: args.confidence },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.evidence_quote === undefined ? {} : { trust: evidence.trust },
        evidence: [evidence.evidence],
      }, exec.signal)
      return JSON.stringify(entry, null, 2)
    },
    presentCall: args => ({ card: 'generic', title: 'Update memory', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Tombstone one memory after the user explicitly requests forgetting or deletion. evidence_quote must exactly match that direct user request.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id.' },
      reason: { type: 'string', required: true, description: 'Concise deletion reason.' },
      evidence_quote: { type: 'string', required: true, description: 'Exact excerpt from the direct user deletion request.' },
    },
    output: textOutput,
    resourceIntents: (_args, exec) => [memoryIntent(requireAgent(exec), resolved, 'write')],
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const evidence = directUserEvidence(agent, args.evidence_quote)
      const entry = await ctx.longTermMemory.forget({
        scope: memoryScope(agent, resolved),
        id: MemoryId(args.id),
        reason: args.reason,
        evidence: [evidence],
      }, exec.signal)
      return JSON.stringify(entry, null, 2)
    },
    presentCall: args => ({ card: 'generic', title: 'Forget memory', kind: 'other', rawInput: args.id }),
  }))
}

function verifiedEvidence(
  agent: Agent,
  quote: string,
): { trust: Exclude<MemoryTrust, 'agent-proposed' | 'external'>; evidence: MemoryEvidence } {
  const normalized = requireText('evidence_quote', quote)
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') {
      if (messageText(event.data).includes(normalized)) {
        return {
          trust: 'user-stated',
          evidence: {
            sessionId: agent.session.id,
            eventSeqs: [event.seq],
            verification: 'user-statement',
            excerpt: normalized,
          },
        }
      }
    }
    if (event?.type === 'tool/result') {
      const result = event.data.message.content[0]
      if (result.isError !== true && nestedText(result.content).includes(normalized)) {
        return {
          trust: 'action-verified',
          evidence: {
            sessionId: agent.session.id,
            eventSeqs: [...event.sourceEventSeqs ?? [], event.seq],
            verification: 'successful-tool-result',
            callId: result.toolCallId,
            excerpt: normalized,
          },
        }
      }
    }
  }
  throw new Error('memory evidence_quote was not found in a direct user message or successful tool result')
}

function directUserEvidence(agent: Agent, quote: string): MemoryEvidence {
  const normalized = requireText('evidence_quote', quote)
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user' && messageText(event.data).includes(normalized)) {
      return {
        sessionId: agent.session.id,
        eventSeqs: [event.seq],
        verification: 'user-statement',
        excerpt: normalized,
      }
    }
  }
  throw new Error('memory_forget evidence_quote was not found in a direct user message')
}

function proposalEvidence(agent: Agent, exec: ToolRunContext): { trust: 'agent-proposed'; evidence: MemoryEvidence } {
  const call = agent.session.events.findLast(event => event.type === 'tool/call' && event.data.callId === exec.callId)
  if (call === undefined) throw new Error('memory write requires its durable tool/call event')
  return {
    trust: 'agent-proposed',
    evidence: {
      sessionId: agent.session.id,
      eventSeqs: [call.seq],
      verification: 'agent-proposal',
      callId: exec.callId,
    },
  }
}

function messageText(message: { content: readonly unknown[] }): string {
  return message.content.flatMap((block) => {
    if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text' || !('text' in block)) return []
    return typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

function nestedText(content: readonly unknown[]): string {
  return messageText({ content })
}

function requireAgent(exec: Pick<ToolRunContext, 'agent'>): Agent {
  if (exec.agent === undefined) throw new Error('memory tools require an Agent-backed session')
  return exec.agent
}

function memoryScope(agent: Agent, config: ResolvedConfig): MemoryScope {
  return {
    workspaceId: config.workspaceId ?? agent.session.header.cwd ?? 'global',
    userId: config.userId,
    agentId: config.agentId,
  }
}

function memoryIntent(agent: Agent, config: ResolvedConfig, access: 'read' | 'write') {
  const scope = memoryScope(agent, config)
  return { key: `memory:${JSON.stringify([scope.workspaceId, scope.userId, scope.agentId])}`, access }
}

function resolveConfig(config: Config): ResolvedConfig {
  const userId = requireText('userId', config.userId ?? DEFAULT_USER_ID)
  const agentId = requireText('agentId', config.agentId ?? DEFAULT_AGENT_ID)
  const workspaceId = config.workspaceId === undefined ? undefined : requireText('workspaceId', config.workspaceId)
  const defaultSearchLimit = config.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT
  if (!Number.isSafeInteger(defaultSearchLimit) || defaultSearchLimit < 1 || defaultSearchLimit > 50) {
    throw new Error('memory defaultSearchLimit must be an integer from 1 through 50')
  }
  return { userId, agentId, ...workspaceId === undefined ? {} : { workspaceId }, defaultSearchLimit }
}

function requireText(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`memory ${name} must not be empty`)
  return normalized
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}
