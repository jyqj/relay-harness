/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@relay-harness/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
import { ConnectionReadiness, type ConnectionReadinessSource } from './readiness.ts'
export type { ConnectionReadinessSource, ConnectionReadinessSnapshot } from './readiness.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a restartable
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including the account home and native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Host handshake and consumer hydration state; a description alone does not imply readiness. */
  readonly readiness: ConnectionReadinessSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * A later `start` after `stop` creates a new loop. A second `start` while
   * a loop is running stops that loop first, then starts the new one. The
   * previous stop handle becomes a no-op so a remount cannot kill the
   * replacement.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop this call started.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? new WebApiClient()
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  let active: { stop(): void } | undefined
  const readiness = new ConnectionReadiness()
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    readiness,
    start(sinks, config) {
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: async (next) => {
          if (active !== loop || closed) return
          readiness.publish('synchronizing', true)
          if (active !== loop || closed) return
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (active !== loop || closed || !Object.is(description, next)) return
          try {
            await sinks.onConnected?.(next)
          } catch (error) {
            if (active === loop && !closed) readiness.publish('error')
            throw error
          }
          if (active === loop && !closed) readiness.publish('ready')
        },
        onStateChange: (state) => {
          if (active !== loop || closed) return
          if (state === 'reconnecting') {
            readiness.publish('reconnecting')
            if (active !== loop || closed) return
            publishDescription(undefined)
          }
          if (active === loop && !closed) sinks.onStateChange?.(state)
        },
      }, config ?? {})
      let closed = false
      const loop = {
        stop: () => {
          if (closed) return
          closed = true
          controller.stop()
          if (active === loop) {
            active = undefined
            readiness.publish('stopped')
            if (active === undefined) publishDescription(undefined)
          }
        },
      }
      const previous = active
      active = loop
      previous?.stop()
      readiness.publish('connecting')
      if (active === loop && !closed) publishDescription(undefined)
      if (active === loop && !closed) controller.start()
      return loop
    },
  }
  ctx.provide('connection', handle)
  ctx.effect(() => () => { active?.stop() }, 'connection: active stream lifetime')
}
