/**
 * Config and capability dumps for `rlh --profile <name> --dump-config` and
 * `rlh --profile <name> --dump-capabilities`: compose the profile's patch
 * layers through the include plugin's patch algorithm without booting or
 * evaluating `!!js`, with one source layer per bundle, the profile's own patch
 * file, and each `--patch` overlay.
 * @module @relay-harness/rlh/dump-config
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  composeEntriesWithProvenance,
  loadOptionalPatches,
  loadOverlayPatches,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@relay-harness/rlh-app-boot'
import {
  buildCapabilityReport,
  type CapabilityComposedEntry,
  type CapabilityReport,
} from '@relay-harness/rlh-host-plugin-inventory'
import { homePatchPath, prepareProfile, PROFILE_ROOT_FILENAME } from './profile-boot.ts'

const NAME = 'rlh'

export interface DumpConfigOptions {
  defaultOnly: boolean
  patches: readonly string[]
  skipUserPlugins?: boolean
}

/** Build the same labeled layers that runDumpConfig prints, without I/O to stdout. */
export function dumpConfigLayers(profile: string, options: DumpConfigOptions): {
  root: string
  layers: ConfigDumpLayer[]
} {
  const skipUserPlugins = options.skipUserPlugins === true
  const loaded = prepareProfile(profile, {
    userLayer: !options.defaultOnly && !skipUserPlugins,
    bundles: skipUserPlugins ? 'template' : 'manifest',
  })
  const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
    label: layer.packageName,
    patches: layer.patches,
  }))
  if (!options.defaultOnly) {
    if (!skipUserPlugins && existsSync(loaded.patchPath)) {
      layers.push({ label: loaded.patchPath, patches: loaded.patches })
    }
    if (!skipUserPlugins) {
      const homePatchFile = homePatchPath()
      const homePatches = loadOptionalPatches(NAME, homePatchFile)
      if (homePatches !== undefined) {
        layers.push({ label: homePatchFile, patches: homePatches })
      }
    }
    for (const file of options.patches) {
      const absolute = resolve(file)
      layers.push({ label: absolute, patches: loadOverlayPatches(NAME, absolute) })
    }
  }
  return { root: join(loaded.dir, PROFILE_ROOT_FILENAME), layers }
}

/** Level fields the human-readable capability dump prints, in report order. */
const LEVEL_LABELS: readonly { key: 'assembled' | 'configured' | 'healthy' | 'sessionAvailable'; label: string }[] = [
  { key: 'assembled', label: 'assembled' },
  { key: 'configured', label: 'configured' },
  { key: 'healthy', label: 'healthy' },
  { key: 'sessionAvailable', label: 'session-available' },
]

/**
 * Render a capability report as deterministic plain text: one headline line
 * per capability, then each level with its evidence. `!!js` expressions stay
 * unevaluated in this boot-free dump, so a requirement whose value is an
 * expression reads as unmet — say so rather than guess.
 * @param report - the report {@link buildCapabilityReport} produced.
 * @param bootFree - whether the runtime levels came from a boot-free dump.
 * @returns the rendered report, ending in one trailing newline.
 */
export function renderCapabilityDump(report: CapabilityReport, bootFree = true): string {
  const lines: string[] = []
  for (const entry of report.capabilities) {
    lines.push(`capability ${entry.capabilityId} — ${entry.label}: ${entry.effective}`)
    for (const { key, label } of LEVEL_LABELS) {
      const level = entry[key]
      const reason = level.reason === undefined ? '' : ` — ${level.reason}`
      lines.push(`  ${label}: ${level.status} [${level.evidence}]${reason}`)
    }
  }
  if (bootFree) {
    lines.push(
      'Note: boot-free dump — `!!js` config expressions are unevaluated and runtime levels are not observed.'
      + ' Query the booted host\'s `pluginInventory/capabilities` remote for the full four-level report.',
    )
  }
  return lines.join('\n') + '\n'
}

/** Build the same boot-free capability report that runDumpCapabilities prints, without I/O. */
export function dumpCapabilityReport(profile: string, options: DumpConfigOptions): CapabilityReport {
  const composed = dumpConfigLayers(profile, options)
  const { composed: rows, provenance } = composeEntriesWithProvenance(NAME, composed.root, composed.layers)
  const entries: CapabilityComposedEntry[] = rows.map((row, index) => {
    const origin = provenance[index]?.origin
    return {
      entryId: row.id,
      moduleName: row.name,
      disabled: row.disabled === true,
      // The loader types composed config as `any`; the report treats it as
      // opaque data that requirement predicates interpret.
      config: row.config as unknown,
      ...(origin === undefined ? {} : { origin }),
    }
  })
  return buildCapabilityReport({ composed: entries })
}

/* v8 ignore start -- built-bin acceptance drives this boot-free dispatch */
/**
 * Print a profile composition with comments naming each source file and patch layer.
 * @param profile - the profile name.
 * @param defaultOnly - omit the profile's user layer and `--patch` overlays
 * (the recovery diagnostic for a broken `cordis.patch.yml`, which is then
 * never parsed).
 * @param patches - `--patch` overlay paths, in argv order.
 */
export function runDumpConfig(
  profile: string,
  defaultOnly: boolean,
  patches: readonly string[],
  skipUserPlugins = false,
): void {
  const composed = dumpConfigLayers(profile, { defaultOnly, patches, skipUserPlugins })
  process.stdout.write(renderConfigDump(NAME, composed.root, composed.layers))
}

/**
 * Print the boot-free effective-capability report: assembled and configured
 * levels from the composed bundle, healthy and session levels as unknown
 * because nothing was booted.
 * @param profile - the profile name.
 * @param patches - `--patch` overlay paths, in argv order.
 * @param skipUserPlugins - compose the shipped template instead of user layers.
 */
export function runDumpCapabilities(profile: string, patches: readonly string[], skipUserPlugins = false): void {
  process.stdout.write(renderCapabilityDump(dumpCapabilityReport(profile, { defaultOnly: false, patches, skipUserPlugins })))
}
/* v8 ignore stop */
