/** Read-only projection of the current Cordis Loader plugin entries and effective capabilities. */

import type { Context, FiberState } from '@relay-harness/cordis'
import type { Entry } from '@relay-harness/cordis-plugin-loader'
import type {} from '@relay-harness/rlh-tools'
import { TypertRemoteService, Remote } from '@relay-harness/rlh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  CapabilityComposedEntry,
  CapabilityReport,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'
import { buildCapabilityReport } from './report.ts'

export type * from './types.ts'
export { buildCapabilityReport } from './report.ts'
export { DEFAULT_CAPABILITY_CATALOG } from './catalog.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    for (const entry of currentLoaderEntries(this.ctx)) {
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    return { entries }
  }

  /**
   * Join the live Loader tree, the tool registry, and the shipped capability
   * catalog into one effective-capability report. The composed bundle evidence
   * is the mounted Loader state itself (config already evaluated), so every
   * level is observable here — unlike the boot-free CLI dump, which reports
   * healthy and session levels as unknown.
   * @returns One report entry per catalog capability, in catalog order.
   */
  @Remote('capabilities')
  capabilities(): CapabilityReport {
    const composed: CapabilityComposedEntry[] = []
    for (const entry of currentLoaderEntries(this.ctx)) {
      composed.push({
        entryId: entry.id,
        moduleName: entry.options.name,
        disabled: entry.disabled,
        config: (entry.options as { config?: unknown }).config,
      })
    }
    const tools = this.ctx.get('tools')
    return buildCapabilityReport({
      composed,
      runtime: {
        inventory: this.list(),
        ...(tools === undefined ? {} : { toolNames: tools.schemas().map(schema => schema.name) }),
      },
    })
  }
}

/** Current non-group Loader entries in Loader order. */
function currentLoaderEntries(ctx: Context): readonly Entry[] {
  return [...ctx.loader.entries()].filter(entry => !entry.options.group)
}

export default PluginInventoryGateway
