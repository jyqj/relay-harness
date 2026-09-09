/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @relay-harness/rlh-sdk-jsonrpc-server/server
 */

import type { Context } from '@relay-harness/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle, AgentOptions } from '@relay-harness/rlh-agent'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { carrierKeyOf, type Scoped } from '@relay-harness/rlh-scope'
import { SessionId } from '@relay-harness/rlh-session'
import type SubagentRuntime from '@relay-harness/rlh-subagent'
import type { SubagentRunEndInfo } from '@relay-harness/rlh-subagent'
import * as LlmDeepSeek from '@relay-harness/rlh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionCloseParams,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@relay-harness/rlh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  /**
   * Set once closeSession began disposing this record. The id stays mapped
   * until the disposal settles, and re-creation chains onto this promise.
   */
  disposeCompletion?: Promise<void>
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for subagent.finished outcomes; root-session prompts carry no prompt-level status. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    return { serverInfo: { name: 'relay-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Queue one identified prompt without assigning later activity to it. An
   * unknown id creates the session — resuming its durable log when one exists
   * (a released id's history), freshly otherwise.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Dispose one SDK session's agent to quiescence, then stop attributing the
   * id to this server. A prompt that arrives while the disposal runs waits for
   * it and reattaches the id; a later prompt for the id does too, resuming the
   * id's durable log when one exists and creating a fresh session otherwise.
   * @param params - the session id to reclaim.
   * @returns empty JSON-RPC result.
   */
  async closeSession(params: SessionCloseParams): Promise<Record<string, never>> {
    const rec = this.sessions.get(params.sessionId)
    // The caller only ever saw ids it created through this server; an unknown
    // id is a caller bug and must not read as success.
    if (rec === undefined) throw new Error(`unknown session: ${params.sessionId}`)
    if (rec.disposeCompletion === undefined) {
      rec.disposeCompletion = Promise.resolve().then(() => rec.handle.dispose())
      // Unregister only after the disposal settles: a pipelined prompt for the
      // id routes onto the completion instead of racing the old agent's
      // unregister in the registry.
      void rec.disposeCompletion.then(
        () => { if (this.sessions.get(params.sessionId) === rec) this.sessions.delete(params.sessionId) },
        () => { if (this.sessions.get(params.sessionId) === rec) this.sessions.delete(params.sessionId) },
      )
    }
    await rec.disposeCompletion
    return {}
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      // A record already mid-disposal (in-flight session/close) owns its
      // dispose call; awaiting the existing completion avoids a second dispose.
      ...records.map(rec => Promise.resolve().then(() => rec.disposeCompletion ?? rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/close':
        return this.closeSession(params as unknown as SessionCloseParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown Relay Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (existing.disposeCompletion === undefined) return existing
      // Chain onto the in-flight close so the fresh session is created after
      // the old agent is unregistered; the id is unmapped by then.
      await existing.disposeCompletion
      return this.getOrCreateSession(sessionId)
    }
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@relay-harness/rlh-agent-presets README, "Composing a child agent").
    const agentOptions: AgentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    const handle = await this.resumeOrCreate(sessionId, agentOptions)
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  /**
   * Publish the session under `sessionId`, resuming its durable log when one
   * exists. The session id is the persistence identity, so re-prompting a
   * released id must reattach that log — creating a second fresh session under
   * it collides with the stored log and the turn would die unpersisted. Resume
   * refuses when the identity has no durable log (first use, or a lifecycle
   * closed before its first append); those fall back to a fresh session, and
   * genuine load failures resurface through that create attempt's own
   * persistence probe.
   */
  private async resumeOrCreate(sessionId: string, agentOptions: AgentOptions): Promise<AgentHandle> {
    try {
      return await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions,
      })
    } catch {
      // Swallowed: the identity had no durable log to resume (or persistence is
      // not configured at all), which is exactly the fresh-create case below. A
      // real load failure fails the create path's own persistence probe.
      return this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: this.cwd },
        agentOptions,
      })
    }
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
