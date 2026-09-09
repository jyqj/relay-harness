/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@relay-harness/cordis'
import commandsRemote from '@relay-harness/rlh-commands/remote'
import goalsRemote from '@relay-harness/rlh-goal/remote'
import issueOrchestrationRemote from '@relay-harness/rlh-issue-orchestrator/remote'
import dynamicRemote from '@relay-harness/rlh-cordis-host-runner/remote'
import fileReferencesRemote from '@relay-harness/rlh-file-reference/remote'
import pluginInventoryRemote from '@relay-harness/rlh-host-plugin-inventory/remote'
import mcpServersRemote from '@relay-harness/rlh-host-mcp-servers/remote'
import skillInventoryRemote from '@relay-harness/rlh-host-skill-inventory/remote'
import memoryCenterRemote from '@relay-harness/rlh-host-memory-center/remote'
import codeIndexCenterRemote from '@relay-harness/rlh-host-code-index-center/remote'
import productModeRemote from '@relay-harness/rlh-host-product-mode/remote'
import workResultsRemote from '@relay-harness/rlh-host-work-results/remote'
import messageFeedbackRemote from '@relay-harness/rlh-message-feedback/remote'
import promptEnhancementRemote from '@relay-harness/rlh-prompt-enhancement/remote'
import sessionReferencesRemote from '@relay-harness/rlh-session-reference/remote'
import type { TypertClientRemote } from '@relay-harness/rlh-typert-protocol'

export type { TypertClientRemote as ClientRemote } from '@relay-harness/rlh-typert-protocol'
export type { ProductMode, ProductModeSnapshot } from '@relay-harness/rlh-host-product-mode/types'
export type { PluginInventorySnapshot } from '@relay-harness/rlh-host-plugin-inventory/types'
export type {
  McpServerEntry, McpServerOrigin, McpServerRecord, McpServerSnapshot,
} from '@relay-harness/rlh-host-mcp-servers/types'
export type {
  SkillInventoryDetail, SkillInventoryEntry, SkillInventorySnapshot,
} from '@relay-harness/rlh-host-skill-inventory/types'
export type {
  MemoryCenterDeleteRequest,
  MemoryCenterDetail,
  MemoryCenterEntry,
  MemoryCenterListRequest,
  MemoryCenterMutationRequest,
  MemoryCenterReadRequest,
  MemoryCenterRejectRequest,
  MemoryCenterReviseRequest,
  MemoryCenterSearchRequest,
  MemoryCenterSnapshot,
  MemoryConflictComparison,
  MemoryOutcomeSummary,
  MemoryUsageCoverage,
  MemoryUsageOccurrence,
} from '@relay-harness/rlh-host-memory-center/types'
export type {} from '@relay-harness/rlh-commands/remote'
export type {} from '@relay-harness/rlh-file-reference/remote'
export type {} from '@relay-harness/rlh-goal/remote'
export type {} from '@relay-harness/rlh-issue-orchestrator/remote'
export type {} from '@relay-harness/rlh-host-plugin-inventory/remote'
export type {} from '@relay-harness/rlh-host-mcp-servers/remote'
export type {} from '@relay-harness/rlh-host-skill-inventory/remote'
export type {} from '@relay-harness/rlh-host-memory-center/remote'
export type {} from '@relay-harness/rlh-host-code-index-center/remote'
export type {} from '@relay-harness/rlh-host-work-results/remote'
export type {} from '@relay-harness/rlh-message-feedback/remote'
export type {} from '@relay-harness/rlh-prompt-enhancement/remote'
export type {} from '@relay-harness/rlh-session-reference/remote'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@relay-harness/rlh-commands/types'
export type {} from '@relay-harness/rlh-cordis-host-runner/types'
export type {} from '@relay-harness/rlh-credentials/types'
export type {} from '@relay-harness/rlh-llm/types'
export type {} from '@relay-harness/rlh-agent-presets/types'
export type {} from '@relay-harness/rlh-settings/types'
export type {} from '@relay-harness/rlh-issue-orchestration/client'
export type {
  IssueCommand,
  IssueOrchestrationEntry,
  IssueOrchestrationSnapshot,
  IssueRefreshResult,
} from '@relay-harness/rlh-issue-orchestration/client'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ClientResponse, ConfigurableProviderView, ConnectionHandle, ConnectionSinks, ContentBlock,
  CredentialView, DirectoryListing, DiscoveredModelView, HistoryEntry, HostFrame, IApiClient,
  MessageId, ModelCatalogFailure, ModelProviderGroup, ModelReasoningEffort, ModelSelection,
  MuxFrame, PromptContentPart, QuestionResponsePayload, QueueAction, RpcError, RpcId, RpcReceipt,
  RpcRequest, RpcResponse, RpcResult, SessionId, SessionModels, SessionSearchItem,
  SessionSummary, SettingsNamespaceView, SettingsPathOpView, SkillEntry, StreamChunk,
  SubagentAddress, SubagentCatalog, JobView, ToolCallView, ToolEventView, ToolResultView,
  WorkspaceId, WorkspaceView,
} from '@relay-harness/rlh-client-connection/client'
export type {} from '@relay-harness/rlh-api-gateway/client'
export type {} from '@relay-harness/rlh-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@relay-harness/rlh-cordis-host-runner/types'
// The JSON vocabulary those payloads are built from, re-exported for the same
// reason: a Client contribution names what it sends without importing a Host
// package, and this assembly is where both planes legitimately meet.
export type { JsonValue } from '@relay-harness/rlh-session/types'
// Durable Context Engine history is delivered through the generic SessionEvent wire. Re-export
// its augmentation and payload vocabulary from the Client assembly so SDK consumers can narrow
// `SessionEvent<'context/prepared'>` without reaching into a Host-only implementation package.
export type {
  ContextPreparedContributionTrace,
  ContextPreparedEventData,
  CoverageRecord,
  Evidence,
} from '@relay-harness/rlh-context-engine/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@relay-harness/rlh-file-reference/types'
export type {
  PromptEnhancementFailure,
  PromptEnhancementModelProvenance,
  PromptEnhancementOutcome,
  PromptEnhancementResult,
} from '@relay-harness/rlh-prompt-enhancement/types'
export type {
  CodeIndexManagementStatus,
  CodeIndexSearchDebugRequest,
  CodeIndexSearchDebugResult,
} from '@relay-harness/rlh-host-code-index-center/types'
export type { SessionReferenceMentionCandidate } from '@relay-harness/rlh-session-reference/types'

declare module '@relay-harness/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: TypertClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      commandsRemote, goalsRemote, issueOrchestrationRemote, dynamicRemote, fileReferencesRemote,
      pluginInventoryRemote, mcpServersRemote, skillInventoryRemote, messageFeedbackRemote,
      memoryCenterRemote, codeIndexCenterRemote, productModeRemote,
      workResultsRemote, promptEnhancementRemote, sessionReferencesRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
