/**
 * Effective-capability report builder: joins one composed bundle, the Loader
 * inventory, and the session tool registry into per-capability
 * assembled/configured/healthy/session-available levels, each with the
 * evidence that backs it. Installed never folds forward — a capability that is
 * merely present in the bundle is never reported as running.
 * @module @relay-harness/rlh-host-plugin-inventory/report
 */

import type {
  CapabilityComposedEntry,
  CapabilityDefinition,
  CapabilityEffectiveState,
  CapabilityLevel,
  CapabilityLevelStatus,
  CapabilityReport,
  CapabilityReportEntry,
  CapabilityReportInput,
  PluginInventoryEntry,
} from './types.ts'
import { DEFAULT_CAPABILITY_CATALOG } from './catalog.ts'

function level(status: CapabilityLevelStatus, evidence: string, reason?: string): CapabilityLevel {
  return reason === undefined ? { status, evidence } : { status, evidence, reason }
}

/** Join the composed bundle against one capability definition: the assembled level. */
function assembledLevel(
  definition: CapabilityDefinition,
  composed: readonly CapabilityComposedEntry[],
): { level: CapabilityLevel; rows: CapabilityComposedEntry[] } {
  const rows = composed.filter(row => definition.entryIds.includes(row.entryId))
  if (rows.length === 0) {
    return {
      rows,
      level: level(
        'no',
        'bundle composition (composed entry list)',
        `no composed bundle entry among [${definition.entryIds.join(', ')}]`,
      ),
    }
  }
  const detail = rows
    .map(row => `entry "${row.entryId}" (${row.moduleName})${row.origin === undefined ? '' : ` from ${row.origin}`}`)
    .join('; ')
  return { rows, level: level('yes', `bundle composition: ${detail}`) }
}

/** Join the composed entry configs against one capability definition: the configured level. */
function configuredLevel(
  definition: CapabilityDefinition,
  composed: readonly CapabilityComposedEntry[],
): CapabilityLevel {
  const requirements = definition.requirements ?? []
  if (requirements.length === 0) {
    return level('yes', 'bundle composition: the capability declares no config requirement')
  }
  const unmet: string[] = []
  const met: string[] = []
  for (const requirement of requirements) {
    const row = composed.find(candidate => candidate.entryId === requirement.entryId)
    if (row === undefined) {
      unmet.push(`entry "${requirement.entryId}" is not in the composed bundle`)
      continue
    }
    if (requirement.satisfied(row.config)) {
      met.push(`entry "${requirement.entryId}": ${requirement.description}`)
    } else {
      unmet.push(`entry "${requirement.entryId}": ${requirement.description}`)
    }
  }
  if (unmet.length > 0) {
    return level('no', 'bundle composition (composed entry configs)', unmet.join('; '))
  }
  return level('yes', `bundle composition (composed entry configs): ${met.join('; ')}`)
}

/** Join the Loader inventory against the assembled rows: the healthy level. */
function healthyLevel(
  definition: CapabilityDefinition,
  rows: readonly CapabilityComposedEntry[],
  runtime: CapabilityReportInput['runtime'],
): CapabilityLevel {
  const disabledRow = rows.find(row => row.disabled)
  if (runtime === undefined) {
    return disabledRow === undefined
      ? level('unknown', 'runtime not observed: the dump composes patch layers without booting')
      : level('no', 'bundle composition', `entry "${disabledRow.entryId}" is disabled in the composed bundle, so its fiber can never activate`)
  }
  const entries: PluginInventoryEntry[] = []
  for (const row of rows) {
    const entry = runtime.inventory.entries.find(
      candidate => candidate.entryId === row.entryId || candidate.moduleName === row.moduleName,
    )
    if (entry !== undefined) entries.push(entry)
  }
  if (entries.length === 0) {
    return level('unknown', 'plugin inventory: no Loader entry matches the assembled rows')
  }
  if (entries.some(entry => !entry.enabled)) {
    return level('no', 'plugin inventory (Loader state)', 'an assembled entry is disabled in the live Loader')
  }
  const failed = entries.find(entry => entry.fiberPhase === 'failed')
  if (failed !== undefined) {
    return level('no', 'plugin inventory (Loader fiber state)', `entry "${failed.moduleName}" fiber failed`)
  }
  const inactive = entries.find(entry => entry.fiberPhase !== 'active')
  if (inactive !== undefined) {
    return level(
      'no',
      'plugin inventory (Loader fiber state)',
      `entry "${inactive.moduleName}" fiber phase is ${inactive.fiberPhase ?? 'null (no live fiber)'}`,
    )
  }
  return level('yes', `plugin inventory: every assembled Loader entry is active (${definition.entryIds.join(', ')})`)
}

/** Join the session tool registry against one capability definition: the session-available level. */
function sessionAvailableLevel(
  definition: CapabilityDefinition,
  runtime: CapabilityReportInput['runtime'],
): CapabilityLevel {
  const toolNames = definition.toolNames ?? []
  if (toolNames.length === 0) {
    return level(
      'yes',
      'session composition: the capability declares no session tool contribution; availability follows plugin activation',
    )
  }
  if (runtime === undefined) {
    return level('unknown', 'session composition not observed: the dump composes patch layers without booting')
  }
  if (runtime.toolNames === undefined) {
    return level('unknown', 'session composition: the queried host exposes no tool registry')
  }
  const missing = toolNames.filter(name => !runtime.toolNames?.includes(name))
  if (missing.length > 0) {
    return level(
      'no',
      `session composition (tool registry with ${runtime.toolNames.length} tools)`,
      `tool(s) not in the session's composed toolset: ${missing.join(', ')}`,
    )
  }
  return level('yes', `session composition: tool(s) present in the session's composed toolset: ${toolNames.join(', ')}`)
}

/** Fold the four levels into the headline state, never forwarding `installed`. */
function effectiveState(entry: Omit<CapabilityReportEntry, 'effective'>): CapabilityEffectiveState {
  if (entry.assembled.status !== 'yes') return 'absent'
  if (entry.configured.status !== 'yes') return 'installed'
  if (entry.healthy.status !== 'yes' || entry.sessionAvailable.status !== 'yes') return 'standby'
  return 'running'
}

/**
 * Build the effective-capability report for one composition plus optional
 * runtime evidence. Levels whose evidence the input does not carry are
 * reported as `unknown` with the reason, never guessed.
 * @param input - the composed bundle rows and, when from a booted host, the
 *   inventory and session tool evidence.
 * @param catalog - capability definitions to join; defaults to the shipped
 *   catalog.
 * @returns one report entry per catalog definition, in catalog order.
 */
export function buildCapabilityReport(
  input: CapabilityReportInput,
  catalog: readonly CapabilityDefinition[] = DEFAULT_CAPABILITY_CATALOG,
): CapabilityReport {
  return {
    capabilities: catalog.map((definition) => {
      const assembled = assembledLevel(definition, input.composed)
      const configured = configuredLevel(definition, input.composed)
      const healthy = healthyLevel(definition, assembled.rows, input.runtime)
      const sessionAvailable = sessionAvailableLevel(definition, input.runtime)
      const withoutEffective = {
        capabilityId: definition.id,
        label: definition.label,
        assembled: assembled.level,
        configured,
        healthy,
        sessionAvailable,
      }
      return { ...withoutEffective, effective: effectiveState(withoutEffective) }
    }),
  }
}
