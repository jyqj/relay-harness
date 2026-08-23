/**
 * Native RLH Agent provider for multi-turn issue runs and captured tracker tools.
 * @module @relay-harness/rlh-issue-runner-agent
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type { Agent, AgentHandle, AgentOptions } from '@relay-harness/rlh-agent'
import { IssueRunner, type IssueRun, type IssueRunEvent, type IssueRunId, type IssueRunRequest, type IssueRunResult } from '@relay-harness/rlh-issue-runner'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId, type JsonValue, type SessionEvent, type TurnEndReason } from '@relay-harness/rlh-session'
import type { ToolDefinition } from '@relay-harness/rlh-tools'

/** Agent route and execution limits for issue attempts. */
export interface Config {
  /** LLM provider route for every issue Agent. */
  readonly provider: string
  /** Model id on the selected provider route. */
  readonly model: string
  /** Optional per-request output-token ceiling. */
  readonly maxTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: z.natural().min(1),
})

/** Convert one captured tracker tool into an agent-scoped RLH definition. */
function trackerToolDefinition(request: IssueRunRequest, tool: IssueRunRequest['trackerTools']['tools'][number]): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    async execute(arguments_: unknown, exec) {
      const result = await request.trackerTools.execute(
        tool.name,
        arguments_ as JsonValue,
        { issue: request.issue },
        exec.signal,
      )
      const rendered = JSON.stringify(result.value, null, 2)
      if (!result.success) throw new Error(rendered)
      return rendered
    },
  }
}

/** Durable terminal event for the exact completed turn. */
function turnEndEvent(agent: Agent, turn: number): SessionEvent<'turn/end'> {
  const event = agent.session.events.findLast(candidate =>
    candidate.type === 'turn/end' && candidate.data.turn === turn)
  /* v8 ignore next -- Agent.whenIdle after waking input guarantees a paired durable turn/end. */
  if (event?.type !== 'turn/end') throw new Error('agent turn ended without a durable turn/end event')
  return event
}

/** Contain optional observer failures so an operator sink cannot fail a run. */
function emit(ctx: Context, listener: IssueRunRequest['onEvent'], event: IssueRunEvent): void {
  try {
    listener?.(event)
  } catch (error: unknown) {
    ctx.logger.warn(`issue-runner-agent observer failed: ${String(error)}`)
  }
}

/** Holder-owned native Agent run. */
class NativeIssueRun implements IssueRun {
  readonly id = randomUUID() as IssueRunId
  readonly result: Promise<IssueRunResult>
  private readonly abort = new AbortController()
  private disposed: Promise<void> | undefined

  constructor(
    readonly sessionId: SessionId,
    private readonly handle: AgentHandle,
    private readonly request: IssueRunRequest,
    private readonly ctx: Context,
  ) {
    /* v8 ignore next -- agents.create rejects an already-aborted creation signal before returning a handle. */
    if (request.signal?.aborted) this.abort.abort(request.signal.reason)
    else request.signal?.addEventListener('abort', this.forwardAbort, { once: true })
    this.result = this.drive()
  }

  private readonly forwardAbort = (): void => {
    this.abort.abort(this.request.signal?.reason)
    this.handle.agent.cancel({ kind: 'user' })
  }

  cancel(reason = 'issue run cancelled'): void {
    if (this.abort.signal.aborted) return
    this.abort.abort(new Error(reason))
    this.handle.agent.cancel({ kind: 'user' })
  }

  dispose(): Promise<void> {
    return (this.disposed ??= (async () => {
      this.cancel('issue run disposed')
      await this.result
    })())
  }

  private async drive(): Promise<IssueRunResult> {
    const { agent } = this.handle
    let turns = 0
    try {
      for (let turn = 1; turn <= this.request.maxTurns; turn += 1) {
        this.abort.signal.throwIfAborted()
        const text = turn === 1
          ? this.request.prompt
          : this.request.continuationPrompt(turn, this.request.maxTurns)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'issue-runner-agent' },
        }))
        await agent.whenIdle()
        turns = turn
        const endEvent = turnEndEvent(agent, turn)
        const reason: TurnEndReason = endEvent.data.reason
        emit(this.ctx, this.request.onEvent, {
          at: Date.now(), kind: 'turn-ended', sessionId: this.sessionId,
          event: endEvent,
        })
        if (reason.kind === 'blocked') {
          return { stopReason: 'blocked', sessionId: this.sessionId, turns, error: 'agent turn was blocked' }
        }
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          const error = reason.kind === 'error'
            ? reason.error.message
            : `agent turn aborted (${reason.reason.kind})`
          return {
            stopReason: this.abort.signal.aborted ? 'cancelled' : 'failed',
            sessionId: this.sessionId,
            turns,
            error,
          }
        }
        const refreshed = await this.request.refreshIssue(this.abort.signal)
        if (refreshed === undefined || !this.request.shouldContinue(refreshed)) break
      }
      return { stopReason: 'completed', sessionId: this.sessionId, turns }
    } catch (error: unknown) {
      return {
        stopReason: this.abort.signal.aborted ? 'cancelled' : 'failed',
        sessionId: this.sessionId,
        turns,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.request.signal?.removeEventListener('abort', this.forwardAbort)
      await this.handle.dispose()
    }
  }
}

/** Native runner that reuses one Session/Agent across continuation turns. */
export class AgentIssueRunner extends IssueRunner {
  static inject = ['agents', 'tools']
  static Config = Config
  private readonly agentOptions: AgentOptions

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (config.provider.trim().length === 0 || config.model.trim().length === 0) {
      throw new Error('issue-runner-agent: provider and model must be non-blank')
    }
    this.agentOptions = {
      provider: config.provider,
      model: config.model,
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    }
  }

  override async start(request: IssueRunRequest): Promise<IssueRun> {
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) {
      throw new TypeError('issue-runner-agent: attempt must be a positive safe integer')
    }
    if (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1) {
      throw new TypeError('issue-runner-agent: maxTurns must be a positive safe integer')
    }
    if (request.workspace.issueId !== request.issue.id) {
      throw new Error('issue-runner-agent: workspace belongs to a different issue')
    }
    const sessionId = SessionId(randomUUID())
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: request.workspace.path },
      agentOptions: this.agentOptions,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      setup: (agentCtx) => {
        const tools = agentCtx.get('tools')
        /* v8 ignore next -- static injection keeps tools present through unpublished setup. */
        if (tools === undefined) throw new Error('issue-runner-agent: tool runtime is unavailable during setup')
        for (const tool of request.trackerTools.tools) tools.register(trackerToolDefinition(request, tool))
        agentCtx.on('session/event', (session, event: SessionEvent) => {
          /* v8 ignore next -- agent-scoped session/event dispatch only delivers this Agent's Session. */
          if (session.id !== sessionId) return
          const kind = event.type === 'assistant/message'
            ? 'assistant'
            : event.type === 'tool/result'
              ? 'tool'
              : undefined
          if (kind !== undefined) emit(this.ctx, request.onEvent, { at: Date.now(), kind, sessionId, event })
        })
      },
    })
    emit(this.ctx, request.onEvent, { at: Date.now(), kind: 'session-started', sessionId })
    return new NativeIssueRun(sessionId, handle, request, this.ctx)
  }
}

export default AgentIssueRunner
