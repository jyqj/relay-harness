#!/usr/bin/env node
/**
 * rlh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @relay-harness/rlh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@relay-harness/rlh-app-boot'
import { parseRlhArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseRlhArgs(process.argv.slice(2), readVersion())

/** Node still labels its supported built-in SQLite module experimental. */
const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time'

/**
 * Suppress only Node's process-level SQLite stability notice while a profile is
 * running. Product warnings, deprecations, and every other experimental notice
 * continue through the original emitter.
 */
async function withoutSqliteExperimentalNotice<T>(operation: () => Promise<T> | T): Promise<T> {
  // oxlint-disable-next-line typescript/unbound-method -- restored verbatim after the scoped run.
  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = warning instanceof Error ? warning.message : warning
    const option = args[0]
    const type = typeof option === 'string'
      ? option
      : option !== null && typeof option === 'object' && 'type' in option
        ? String(option.type)
        : undefined
    if (message === SQLITE_EXPERIMENTAL_WARNING && type === 'ExperimentalWarning') return
    Reflect.apply(original, process, [warning, ...args])
  })
  try {
    return await operation()
  } finally {
    process.emitWarning = original
  }
}

switch (invocation.mode) {
  case 'profile': {
    await withoutSqliteExperimentalNotice(async () => {
      const { runProfile } = await import('./profile-boot.ts')
      await runProfile({
        environment: loadLayeredEnv('rlh'),
        profile: invocation.profile,
        patchFiles: invocation.patches,
        args: invocation.args,
        skipUserPlugins: invocation.skipUserPlugins,
      })
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    await withoutSqliteExperimentalNotice(async () => {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches, invocation.skipUserPlugins)
    })
    break
  }
  default:
    invocation satisfies never
    throw new Error(`rlh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
