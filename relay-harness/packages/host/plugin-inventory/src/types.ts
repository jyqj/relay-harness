import type { Branded } from '@relay-harness/rlh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
}

/** Outcome of one effective-capability level: known yes, known no, or not observed. */
export type CapabilityLevelStatus = 'yes' | 'no' | 'unknown'

/**
 * Folded state of one capability across all levels: `absent` (not assembled),
 * `installed` (assembled but config requirements unmet or unchecked), `standby`
 * (configured but not healthy or not in the session toolset), or `running`
 * (every observed level is yes). `installed` never folds forward: a capability
 * that is merely installed is never reported as running.
 */
export type CapabilityEffectiveState = 'absent' | 'installed' | 'standby' | 'running'

/** One effective-capability level with the evidence that backs it. */
export interface CapabilityLevel {
  readonly status: CapabilityLevelStatus
  /** Where the fact came from: bundle composition, Loader config, inventory, or session toolset. */
  readonly evidence: string
  /** Why the level is not satisfied; present when `status` is `'no'`. */
  readonly reason?: string
}

/** One capability joined across the installed/configured/healthy/session-available levels. */
export interface CapabilityReportEntry {
  /** Stable catalog id, e.g. `code-index`. */
  readonly capabilityId: string
  /** Human label for report rendering. */
  readonly label: string
  /** The plugin/module is present in the composed bundle. Evidence: bundle composition. */
  readonly assembled: CapabilityLevel
  /** The composed config supplies what the capability needs. Evidence: composed entry config. */
  readonly configured: CapabilityLevel
  /** The plugin is actually active without error. Evidence: plugin inventory (runtime) or composition. */
  readonly healthy: CapabilityLevel
  /** The session's composed toolset exposes the capability's tools. Evidence: session tool composition. */
  readonly sessionAvailable: CapabilityLevel
  /** The four levels folded into one honest headline state. */
  readonly effective: CapabilityEffectiveState
}

/** Point-in-time effective-capability view over one composition plus optional runtime evidence. */
export interface CapabilityReport {
  readonly capabilities: readonly CapabilityReportEntry[]
}

/** One composed bundle row the report builder reads (Loader entry id/module/config plus provenance). */
export interface CapabilityComposedEntry {
  /** Loader entry id from the composed bundle, or the empty string when the row declares none. */
  readonly entryId: string
  /** Exact module specifier the row mounts. */
  readonly moduleName: string
  /** Whether the composed row disables the entry. */
  readonly disabled: boolean
  /** The row's composed config, as written (a boot-free dump leaves `!!js` unevaluated). */
  readonly config: unknown
  /** Source file the row came from, when the caller tracked patch-layer provenance. */
  readonly origin?: string
}

/** Runtime evidence gathered from a booted host. */
export interface CapabilityRuntimeEvidence {
  /** Current Loader projection; backs the healthy level. */
  readonly inventory: PluginInventorySnapshot
  /** Tool names in the queried host's tool registry; absent when the registry is unavailable. */
  readonly toolNames?: readonly string[]
}

/** Inputs of the shared effective-capability report builder. */
export interface CapabilityReportInput {
  /** The composed bundle rows; backs the assembled and configured levels. */
  readonly composed: readonly CapabilityComposedEntry[]
  /** Booted-host evidence; absent in a boot-free dump, which then reports those levels as unknown. */
  readonly runtime?: CapabilityRuntimeEvidence
}

/** One config requirement a capability needs from one composed entry's config. */
export interface CapabilityConfigRequirement {
  /** Complete statement of what must be configured, shown verbatim when unmet. */
  readonly description: string
  /** Loader entry id whose config the requirement reads. */
  readonly entryId: string
  /**
   * Whether the entry's composed config satisfies the requirement. Receives the
   * config as written: a boot-free dump passes `!!js` expressions unevaluated.
   */
  readonly satisfied: (config: unknown) => boolean
}

/** One capability the report knows how to join across levels. */
export interface CapabilityDefinition {
  /** Stable report id. */
  readonly id: string
  /** Human label for report rendering. */
  readonly label: string
  /** Loader entry ids whose presence in the composed bundle marks the capability assembled. */
  readonly entryIds: readonly string[]
  /** Config requirements, all of which must hold for `configured: yes`; absent declares none. */
  readonly requirements?: readonly CapabilityConfigRequirement[]
  /** Model-facing tool names the capability contributes; absent declares no session tool contribution. */
  readonly toolNames?: readonly string[]
}
