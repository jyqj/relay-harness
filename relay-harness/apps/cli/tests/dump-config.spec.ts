/**
 * Skip-user-plugins dump lists template bundle layers plus `--patch` files,
 * never the profile or home user patch files; the capability dump joins the
 * composed bundle into per-level facts and reports runtime levels as unknown.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  PROFILES_DIR,
} from '@relay-harness/rlh-app-boot'
import { dumpCapabilityReport, dumpConfigLayers, renderCapabilityDump } from '../src/dump-config.ts'

const tmpDirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-dump-config-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

describe('dumpConfigLayers', () => {
  it('skip-user-plugins lists template bundles and --patch, not user YAML', () => {
    const home = tmp()
    vi.stubEnv('RLH_HOME', home)
    const dir = join(home, PROFILES_DIR, 'web')
    initProfile(dir, [...PROFILE_TEMPLATES.web ?? [], 'ghost-bundle'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), 'not: a list\n')
    writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: missing\n  config: {}\n')
    const overlay = join(home, 'extra.yml')
    writeFileSync(overlay, '- id: session-telemetry-otel\n  disabled: true\n')
    const { layers } = dumpConfigLayers('web', {
      defaultOnly: false,
      skipUserPlugins: true,
      patches: [overlay],
    })
    expect(layers.map(layer => layer.label)).toEqual([
      ...PROFILE_TEMPLATES.web ?? [],
      overlay,
    ])
  })
})

describe('dumpCapabilityReport', () => {
  it('joins the composed web profile: session search follows openAt, runtime stays unknown', () => {
    const home = tmp()
    vi.stubEnv('RLH_HOME', home)
    const dir = join(home, PROFILES_DIR, 'web')
    initProfile(dir, PROFILE_TEMPLATES.web ?? [])
    // The shipped base layer configures openAt "never"; the overlay opens it.
    const overlay = join(home, 'open.yml')
    writeFileSync(overlay, '- id: session-query-sqlite\n  config:\n    path: ":memory:"\n    openAt: first-search\n')
    const report = dumpCapabilityReport('web', { defaultOnly: false, patches: [overlay], skipUserPlugins: false })

    const sessionSearch = report.capabilities.find(entry => entry.capabilityId === 'session-full-text-search')
    expect(sessionSearch?.assembled.status).toBe('yes')
    expect(sessionSearch?.assembled.evidence).toContain('session-query-sqlite')
    expect(sessionSearch?.configured.status).toBe('yes')
    expect(sessionSearch?.configured.evidence).toContain('openAt')
    expect(sessionSearch?.healthy.status).toBe('unknown')
    expect(sessionSearch?.sessionAvailable.status).toBe('unknown')
    expect(sessionSearch?.effective).toBe('standby')

    // The web profile assembles the code-index router, but its shipped config
    // carries no embedding section: installed, unconfigured, not running.
    const codeIndex = report.capabilities.find(entry => entry.capabilityId === 'code-index')
    expect(codeIndex?.assembled.status).toBe('yes')
    expect(codeIndex?.configured.status).toBe('no')
    expect(codeIndex?.configured.reason).toContain('embedding')
    expect(codeIndex?.effective).toBe('installed')

    const text = renderCapabilityDump(report)
    expect(text).toContain('capability session-full-text-search')
    expect(text).toContain('session-available: unknown')
    expect(text).toContain('boot-free dump')
    expect(text.endsWith('\n')).toBe(true)
  })
})
