/**
 * Markdown/YAML file provider with startup validation and last-known-good reload.
 * @module @relay-harness/rlh-issue-workflow-file
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import { parse as parseYaml } from 'yaml'
import { IssueWorkflow, type IssueWorkflowPolicy, type IssueWorkflowSnapshot } from '@relay-harness/rlh-issue-workflow'
import { deepFreeze } from '@relay-harness/rlh-llm'

const DEFAULT_CONTINUATION = 'Continue the current tracker issue from the existing workspace and session context. Complete the remaining work or update the tracker when genuinely blocked.'

/** Absolute repository workflow document selection. */
export interface Config {
  /** Absolute Markdown workflow document path. */
  readonly path: string
}

export const Config: z<Config> = z.object({ path: z.string() })

interface RawDocument {
  tracker?: {
    provider?: unknown
    active_states?: unknown
    terminal_states?: unknown
    required_labels?: unknown
  }
  polling?: { interval_ms?: unknown }
  agent?: {
    max_concurrent_runs?: unknown
    max_concurrent_runs_by_state?: unknown
    max_turns?: unknown
    max_retry_backoff_ms?: unknown
  }
  orchestration?: {
    continuation_retry_ms?: unknown
    max_continuation_attempts?: unknown
    failure_retry_base_ms?: unknown
    stall_timeout_ms?: unknown
    continuation_prompt?: unknown
  }
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim() !== value) {
    throw new Error(`issue workflow ${field} must be a non-blank trimmed string`)
  }
  return value
}

function stringList(value: unknown, field: string, fallback: readonly string[] = []): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new Error(`issue workflow ${field} must be an array`)
  const result = value.map(entry => nonBlank(entry, field))
  if (new Set(result.map(entry => entry.toLowerCase())).size !== result.length) {
    throw new Error(`issue workflow ${field} contains duplicates`)
  }
  return result
}

function positive(value: unknown, field: string, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1) {
    throw new Error(`issue workflow ${field} must be a positive safe integer`)
  }
  return resolved as number
}

function nonNegative(value: unknown, field: string, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) {
    throw new Error(`issue workflow ${field} must be a non-negative safe integer`)
  }
  return resolved as number
}

function stateLimits(value: unknown): Record<string, number> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('issue workflow agent.max_concurrent_runs_by_state must be an object')
  }
  return Object.fromEntries(Object.entries(value).map(([state, limit]) => [
    nonBlank(state, 'agent.max_concurrent_runs_by_state key').toLowerCase(),
    positive(limit, `agent.max_concurrent_runs_by_state.${state}`, 1),
  ]))
}

function splitDocument(text: string): { frontmatter: RawDocument; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (match === null) return { frontmatter: {}, body: text.trim() }
  /* v8 ignore next -- both regex capture groups are structurally mandatory when match is non-null. */
  const parsed: unknown = parseYaml(match[1] ?? '', { uniqueKeys: true })
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('issue workflow front matter must be an object')
  }
  /* v8 ignore next -- both regex capture groups are structurally mandatory when match is non-null. */
  return { frontmatter: parsed, body: (match[2] ?? '').trim() }
}

/**
 * Parse and validate one complete workflow document.
 * @param text Markdown with optional YAML front matter.
 * @returns The resolved immutable issue automation policy.
 */
export function parseIssueWorkflow(text: string): IssueWorkflowPolicy {
  const { frontmatter, body } = splitDocument(text)
  if (body.length === 0) throw new Error('issue workflow prompt body must be non-blank')
  const tracker = frontmatter.tracker ?? {}
  const polling = frontmatter.polling ?? {}
  const agent = frontmatter.agent ?? {}
  const orchestration = frontmatter.orchestration ?? {}
  return deepFreeze({
    trackerProvider: nonBlank(tracker.provider, 'tracker.provider'),
    activeStates: stringList(tracker.active_states, 'tracker.active_states', ['Todo', 'In Progress']),
    terminalStates: stringList(tracker.terminal_states, 'tracker.terminal_states', ['Done', 'Closed', 'Cancelled']),
    requiredLabels: stringList(tracker.required_labels, 'tracker.required_labels'),
    pollIntervalMs: positive(polling.interval_ms, 'polling.interval_ms', 30_000),
    maxConcurrentRuns: positive(agent.max_concurrent_runs, 'agent.max_concurrent_runs', 10),
    maxConcurrentRunsByState: stateLimits(agent.max_concurrent_runs_by_state),
    maxTurns: positive(agent.max_turns, 'agent.max_turns', 20),
    continuationRetryMs: positive(orchestration.continuation_retry_ms, 'orchestration.continuation_retry_ms', 1_000),
    maxContinuationAttempts: nonNegative(orchestration.max_continuation_attempts, 'orchestration.max_continuation_attempts', 5),
    failureRetryBaseMs: positive(orchestration.failure_retry_base_ms, 'orchestration.failure_retry_base_ms', 10_000),
    maxRetryBackoffMs: positive(agent.max_retry_backoff_ms, 'agent.max_retry_backoff_ms', 300_000),
    stallTimeoutMs: nonNegative(orchestration.stall_timeout_ms, 'orchestration.stall_timeout_ms', 300_000),
    promptTemplate: body,
    continuationTemplate: orchestration.continuation_prompt === undefined
      ? DEFAULT_CONTINUATION
      : nonBlank(orchestration.continuation_prompt, 'orchestration.continuation_prompt'),
  })
}

/** File-backed provider retaining its last valid revision after reload failures. */
export class FileIssueWorkflow extends IssueWorkflow {
  static Config = Config
  private snapshot: IssueWorkflowSnapshot | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    if (!isAbsolute(config.path)) throw new Error('issue-workflow-file: path must be absolute')
  }

  protected async [Service.init](): Promise<void> {
    this.snapshot = await this.load()
  }

  override current(): IssueWorkflowSnapshot {
    if (this.snapshot === undefined) throw new Error('issue-workflow-file: provider is not initialized')
    return this.snapshot
  }

  override async reload(): Promise<boolean> {
    const previous = this.current()
    try {
      const next = await this.load()
      if (next.revision === previous.revision) return false
      this.snapshot = next
      this.ctx.emit('issue-workflow/updated', next, previous)
      return true
    } catch (error: unknown) {
      this.ctx.logger.error(`issue workflow reload failed for ${this.config.path}; keeping revision ${previous.revision}: ${String(error)}`)
      return false
    }
  }

  private async load(): Promise<IssueWorkflowSnapshot> {
    const text = await readFile(this.config.path, 'utf8')
    const revision = createHash('sha256').update(text).digest('hex').slice(0, 32)
    return deepFreeze({
      path: this.config.path,
      revision,
      loadedAt: Date.now(),
      policy: parseIssueWorkflow(text),
    })
  }
}

export default FileIssueWorkflow
