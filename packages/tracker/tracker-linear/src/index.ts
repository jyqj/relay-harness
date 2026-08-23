/**
 * Linear GraphQL tracker provider with paged reads and a session-bound raw GraphQL tool.
 * @module @deepseek-ai/dsh-tracker-linear
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TrackerIssueId, type TrackerIssue, type TrackerProvider, type TrackerToolBinding, type TrackerToolContext, type TrackerToolResult } from '@deepseek-ai/dsh-tracker'
import type { TrackerIssueId as TrackerIssueIdValue } from '@deepseek-ai/dsh-tracker/types'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

const ISSUE_PAGE_SIZE = 50
const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql'
const DEFAULT_TERMINAL_STATES: readonly string[] = ['Done', 'Closed', 'Cancelled', 'Canceled', 'Duplicate']
const DEFAULT_BLOCK_NEW_STATES: readonly string[] = ['Todo']

const ISSUE_FIELDS = `
  id identifier title description priority branchName url createdAt updatedAt
  state { name }
  assignee { id }
  labels { nodes { name } }
  inverseRelations(first: $relationFirst) {
    nodes { type issue { id identifier state { name } } }
  }
`

const POLL_QUERY = `query DshLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

const IDS_QUERY = `query DshLinearIssuesById($ids: [ID!]!, $projectSlug: String!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}, project: {slugId: {eq: $projectSlug}}}, first: $first) {
    nodes { ${ISSUE_FIELDS} }
  }
}`

const VIEWER_QUERY = 'query DshLinearViewer { viewer { id } }'

/** Linear endpoint, scope, routing, auth, and provider-name configuration. */
export interface Config {
  /** Registry name used by workflow policy (default `linear`). */
  readonly providerName: string
  /** HTTPS Linear GraphQL endpoint. */
  readonly endpoint: string
  /** Optional literal API key; prefer `apiKeyEnv` for repository-owned composition. */
  readonly apiKey?: string
  /** Host environment variable carrying the API key (default `LINEAR_API_KEY`). */
  readonly apiKeyEnv: string
  /** Linear project slug that scopes every scheduler read. */
  readonly projectSlug: string
  /** Optional assignee id or `me` routing filter. */
  readonly assignee?: string
  /** States treated as terminal when evaluating blockers. */
  readonly terminalStates: string[]
  /** New-work states whose non-terminal blockers prevent dispatch. */
  readonly blockNewStates: string[]
}

/** Input accepted by {@link Config}; schema defaults fill the omitted fields. */
export interface ConfigInput {
  readonly providerName?: string
  readonly endpoint?: string
  readonly apiKey?: string
  readonly apiKeyEnv?: string
  readonly projectSlug: string
  readonly assignee?: string
  readonly terminalStates?: string[]
  readonly blockNewStates?: string[]
}

export const Config: z<ConfigInput, Config> = z.object({
  providerName: z.string().default('linear'),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().default('LINEAR_API_KEY'),
  projectSlug: z.string(),
  assignee: z.string(),
  terminalStates: z.array(z.string()).default([...DEFAULT_TERMINAL_STATES]),
  blockNewStates: z.array(z.string()).default([...DEFAULT_BLOCK_NEW_STATES]),
})

interface ResolvedConfig {
  readonly providerName: string
  readonly endpoint: string
  readonly apiKey: string
  readonly apiKeyEnv: string
  readonly projectSlug: string
  readonly assignee?: string
  readonly terminalStates: readonly string[]
  readonly blockNewStates: readonly string[]
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Linear ${label} must be an object`)
  return value as Record<string, unknown>
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return nonBlank(current)
}

function arrayAt(value: unknown, ...path: string[]): readonly unknown[] {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return []
    current = (current as Record<string, unknown>)[key]
  }
  return Array.isArray(current) ? current : []
}

function time(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalized(value: string): string { return value.trim().toLowerCase() }

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Linear provider whose constructor captures all effective configuration and auth. */
export class LinearTrackerProvider implements TrackerProvider {
  readonly name: string
  private viewerId: string | undefined

  constructor(private readonly config: ResolvedConfig) {
    this.name = config.providerName
  }

  async fetchIssuesByStates(states: readonly string[], signal?: AbortSignal): Promise<readonly TrackerIssue[]> {
    const requested = [...new Set(states.map(state => state.trim()).filter(Boolean))]
    if (requested.length === 0) return []
    const assignee = await this.resolveAssignee(signal)
    const results: TrackerIssue[] = []
    let after: string | null = null
    do {
      const body = await this.graphql(POLL_QUERY, {
        projectSlug: this.config.projectSlug,
        stateNames: requested,
        first: ISSUE_PAGE_SIZE,
        relationFirst: ISSUE_PAGE_SIZE,
        after,
      }, signal)
      const issues = object(object(body, 'response').data, 'data').issues
      const connection = object(issues, 'issues')
      for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
        const normalizedIssue = this.normalizeIssue(node, assignee, false)
        if (normalizedIssue !== undefined) results.push(normalizedIssue)
      }
      const pageInfo = object(connection.pageInfo, 'pageInfo')
      if (pageInfo.hasNextPage !== true) after = null
      else {
        const cursor = nonBlank(pageInfo.endCursor)
        if (cursor === undefined) throw new Error('Linear page reports hasNextPage without endCursor')
        after = cursor
      }
    } while (after !== null)
    return results
  }

  async fetchIssuesByIds(ids: readonly TrackerIssueIdValue[], signal?: AbortSignal): Promise<readonly TrackerIssue[]> {
    const requested = [...new Set(ids)]
    if (requested.length === 0) return []
    const assignee = await this.resolveAssignee(signal)
    const byId = new Map<TrackerIssueIdValue, TrackerIssue>()
    for (let offset = 0; offset < requested.length; offset += ISSUE_PAGE_SIZE) {
      const batch = requested.slice(offset, offset + ISSUE_PAGE_SIZE)
      const body = await this.graphql(IDS_QUERY, {
        ids: batch,
        projectSlug: this.config.projectSlug,
        first: batch.length,
        relationFirst: ISSUE_PAGE_SIZE,
      }, signal)
      const nodes = object(object(object(body, 'response').data, 'data').issues, 'issues').nodes
      if (!Array.isArray(nodes)) throw new Error('Linear issues nodes must be an array')
      for (const node of nodes) {
        const issue = this.normalizeIssue(node, assignee, true)
        if (issue === undefined) throw new Error('Linear returned a malformed issue during id refresh')
        byId.set(issue.id, issue)
      }
    }
    return requested.flatMap((id) => {
      const issue = byId.get(id)
      return issue === undefined ? [] : [issue]
    })
  }

  bindTools(): TrackerToolBinding {
    const config = this.config
    const parameters: ObjectJsonSchema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GraphQL query or mutation document.' },
        variables: {
          oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
          description: 'Optional GraphQL variables.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    }
    return Object.freeze({
      provider: this.name,
      tools: Object.freeze([{
        name: 'linear_graphql',
        description: 'Execute one raw Linear GraphQL query or mutation with host-held authentication.',
        parameters: parameters as unknown as Readonly<Record<string, JsonValue>>,
      }]),
      secretEnvironmentNames: Object.freeze([...new Set([config.apiKeyEnv, 'LINEAR_API_KEY'])]),
      execute: async (
        name: string,
        arguments_: JsonValue,
        _context: TrackerToolContext,
        signal?: AbortSignal,
      ): Promise<TrackerToolResult> => {
        if (name !== 'linear_graphql') return { success: false, value: { error: 'unsupported tool' } }
        if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
          return { success: false, value: { error: 'linear_graphql arguments must be an object' } }
        }
        const args = arguments_ as Record<string, JsonValue>
        const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
        if (query.length === 0) return { success: false, value: { error: 'linear_graphql requires query' } }
        const variables = args['variables'] ?? {}
        if (typeof variables !== 'object' || Array.isArray(variables)) {
          return { success: false, value: { error: 'linear_graphql variables must be an object or null' } }
        }
        try {
          const response = await this.graphql(query, variables, signal, false)
          const errors = object(response, 'tool response').errors
          return { success: !Array.isArray(errors) || errors.length === 0, value: jsonValue(response) }
        } catch (error: unknown) {
          return { success: false, value: { error: error instanceof Error ? error.message : String(error) } }
        }
      },
    })
  }

  private async resolveAssignee(signal?: AbortSignal): Promise<string | undefined> {
    const configured = this.config.assignee
    if (configured === undefined || configured === '') return undefined
    if (normalized(configured) !== 'me') return configured
    if (this.viewerId !== undefined) return this.viewerId
    // Cache only a committed identity. A transient or caller-aborted lookup must not
    // poison every later poll with the same rejected Promise.
    const body = await this.graphql(VIEWER_QUERY, {}, signal)
    const id = stringAt(body, 'data', 'viewer', 'id')
    if (id === undefined) throw new Error('Linear viewer query returned no id')
    this.viewerId = id
    return id
  }

  private normalizeIssue(value: unknown, assignee: string | undefined, strict: boolean): TrackerIssue | undefined {
    let issue: Record<string, unknown>
    try { issue = object(value, 'issue') } catch (error) { if (strict) throw error; return undefined }
    const id = nonBlank(issue.id)
    const identifier = nonBlank(issue.identifier)
    const title = nonBlank(issue.title)
    const state = stringAt(issue, 'state', 'name')
    if (id === undefined || identifier === undefined || title === undefined || state === undefined) return undefined
    const labels = arrayAt(issue, 'labels', 'nodes')
      .flatMap(label => stringAt(label, 'name') ?? [])
      .map(normalized)
      .filter(Boolean)
    const blockers = arrayAt(issue, 'inverseRelations', 'nodes').flatMap((relation) => {
      if (stringAt(relation, 'type') !== 'blocks') return []
      const blockerId = stringAt(relation, 'issue', 'id')
      const blockerState = stringAt(relation, 'issue', 'state', 'name')
      return blockerId === undefined ? [] : [{ id: TrackerIssueId(blockerId), state: blockerState }]
    })
    const assigned = assignee === undefined || stringAt(issue, 'assignee', 'id') === assignee
    const blocksNew = this.config.blockNewStates.map(normalized).includes(normalized(state))
      && blockers.some(blocker => blocker.state === undefined
        || !this.config.terminalStates.map(normalized).includes(normalized(blocker.state)))
    const priority = typeof issue.priority === 'number' && Number.isInteger(issue.priority) ? issue.priority : undefined
    const createdAt = time(issue.createdAt)
    const updatedAt = time(issue.updatedAt)
    const description = typeof issue.description === 'string' ? issue.description : undefined
    const branchName = nonBlank(issue.branchName)
    const url = nonBlank(issue.url)
    const assigneeId = stringAt(issue, 'assignee', 'id')
    return {
      id: TrackerIssueId(id),
      identifier,
      title,
      state,
      labels: [...new Set(labels)],
      blockedBy: blockers.map(blocker => blocker.id),
      dispatchable: assigned && !blocksNew,
      ...(description === undefined ? {} : { description }),
      ...(priority === undefined ? {} : { priority }),
      ...(branchName === undefined ? {} : { branchName }),
      ...(url === undefined ? {} : { url }),
      ...(assigneeId === undefined ? {} : { assigneeId }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt, revision: String(updatedAt) }),
    }
  }

  private async graphql(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    rejectGraphqlErrors = true,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: { Authorization: this.config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Linear GraphQL HTTP ${String(response.status)}: ${text.slice(0, 1000)}`)
    let body: unknown
    try { body = JSON.parse(text) } catch (error: unknown) { throw new Error('Linear GraphQL returned invalid JSON', { cause: error }) }
    const errors = object(body, 'response').errors
    if (rejectGraphqlErrors && Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${JSON.stringify(errors).slice(0, 2000)}`)
    }
    return body
  }
}

export const name = 'tracker-linear'
export const inject = ['trackers']

/** Register one fully resolved Linear provider; the schema supplies every defaulted field. */
export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKey ?? process.env[config.apiKeyEnv]
  if (config.providerName.trim().length === 0) throw new Error('tracker-linear: providerName must be non-blank')
  if (!URL.canParse(config.endpoint) || new URL(config.endpoint).protocol !== 'https:') throw new Error('tracker-linear: endpoint must be HTTPS')
  if (apiKey === undefined || apiKey.trim().length === 0) throw new Error(`tracker-linear: missing API key (${config.apiKeyEnv})`)
  if (config.projectSlug.trim().length === 0) throw new Error('tracker-linear: projectSlug must be non-blank')
  ctx.trackers.register(new LinearTrackerProvider({
    providerName: config.providerName,
    endpoint: config.endpoint,
    apiKey,
    apiKeyEnv: config.apiKeyEnv,
    projectSlug: config.projectSlug,
    ...(config.assignee === undefined ? {} : { assignee: config.assignee.trim() }),
    terminalStates: config.terminalStates,
    blockNewStates: config.blockNewStates,
  }))
}
