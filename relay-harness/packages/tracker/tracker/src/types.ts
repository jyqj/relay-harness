/** Provider-neutral issue-tracker values shared by schedulers and tool consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'

/** Stable dispatch identity inside one configured tracker provider. */
export type TrackerIssueId = Branded<'TrackerIssueId'>

/** Normalized work item used by provider-independent scheduling policy. */
export interface TrackerIssue {
  readonly id: TrackerIssueId
  readonly nativeRef?: Readonly<Record<string, JsonValue>>
  readonly identifier: string
  readonly title: string
  readonly description?: string
  readonly priority?: number
  readonly state: string
  readonly branchName?: string
  readonly url?: string
  readonly assigneeId?: string
  readonly labels: readonly string[]
  readonly blockedBy: readonly TrackerIssueId[]
  readonly dispatchable: boolean
  readonly createdAt?: number
  readonly updatedAt?: number
  /** Provider revision used to reject a dispatch decision made from stale data. */
  readonly revision?: string
}

/** One provider-native tool advertised to an issue's agent scope. */
export interface TrackerToolSpec {
  readonly name: string
  readonly description: string
  /** Object-rooted JSON Schema; the registry validates the enforced tool subset at capture. */
  readonly parameters: Readonly<Record<string, JsonValue>>
}

/** Context retained by the host, never placed in model-visible tool arguments. */
export interface TrackerToolContext {
  readonly issue: TrackerIssue
}

/** Stable JSON result returned across a tracker-tool execution boundary. */
export interface TrackerToolResult {
  readonly success: boolean
  readonly value: JsonValue
}

/** Immutable provider/tool selection captured for one agent session. */
export interface TrackerToolBinding {
  readonly provider: string
  readonly tools: readonly TrackerToolSpec[]
  /**
   * Environment names that carry the provider credential, captured as declarative metadata.
   * No runtime consumer wires this list today: managed-child scrubbing is the subprocess
   * seam's generic credential-shaped `scrubbedParentEnv()` base, which never forwards
   * credential-shaped names regardless of this declaration.
   */
  readonly secretEnvironmentNames: readonly string[]
  execute(
    name: string,
    arguments_: JsonValue,
    context: TrackerToolContext,
    signal?: AbortSignal,
  ): Promise<TrackerToolResult>
}

/** Tracker implementation registered under one deployment-selected name. */
export interface TrackerProvider {
  readonly name: string
  fetchIssuesByStates(states: readonly string[], signal?: AbortSignal): Promise<readonly TrackerIssue[]>
  fetchIssuesByIds(ids: readonly TrackerIssueId[], signal?: AbortSignal): Promise<readonly TrackerIssue[]>
  /** Capture adapter selection, effective configuration, tools, and secret aliases as one snapshot. */
  bindTools(): TrackerToolBinding
}
