/**
 * The bundle's substance is its patch file: the `rlh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@relay-harness/cordis-plugin-include'
import { evaluate } from '@relay-harness/cordis-plugin-loader'

describe('rlh-base bundle', () => {
  it('declares a parseable patch list through the rlh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      rlh?: { bundle?: { patch?: string } }
    }
    expect(manifest.rlh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.rlh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.filter(row => row.id === 'context-engine')).toHaveLength(1)
    expect(rows.find(row => row.id === 'context-engine')?.config).toEqual({
      maxChars: 64000,
      maxTokens: 16000,
      maxContributorChars: 64000,
      maxContributorTokens: 16000,
      contributorTimeoutMs: 5000,
    })
    expect(rows.filter(row => row.id === 'mcp-catalog')).toHaveLength(1)
    expect(rows.find(row => row.id === 'session-history-context')?.config).toEqual({
      maxExchanges: 12,
      maxChars: 24000,
      maxTokens: 6000,
    })
    const sandboxMode = rows.find(row => row.id === 'sandbox-policy')?.config?.['mode'] as { __jsExpr: string }
    const approvalPolicy = rows.find(row => row.id === 'approval')?.config?.['policy'] as { __jsExpr: string }
    expect(evaluate({ process: { env: {} } }, sandboxMode.__jsExpr)).toBe('workspace-write')
    expect(evaluate({ process: { env: {} } }, approvalPolicy.__jsExpr)).toBe('ask')
    expect(evaluate({ process: { env: { RLH_PERMISSION_MODE: 'danger-full-access' } } }, sandboxMode.__jsExpr))
      .toBe('danger-full-access')
    expect(evaluate({ process: { env: { RLH_PERMISSION_MODE: 'danger-full-access' } } }, approvalPolicy.__jsExpr))
      .toBe('never')
    expect(rows.find(row => row.id === 'permission')?.config?.['presets']).toMatchObject({
      'workspace-write': { name: 'Standard', approval: 'ask' },
      'danger-full-access': { name: 'Developer Mode', approval: 'never' },
    })
    expect(rows.find(row => row.id === 'memory-agent')?.config).toMatchObject({
      agentPresets: ['standard'],
      candidateLimit: 10,
      maxContextChars: 3200,
    })
    const subagentConfig = rows.find(row => row.id === 'subagent')?.config
    expect(subagentConfig).toMatchObject({
      maxActivePerRoot: 4,
      overflow: 'reject',
      activationLeaseMs: 30000,
      activationLeaseRenewMs: 10000,
    })
    expect((subagentConfig?.['activationLeasePath'] as { __jsExpr: string }).__jsExpr)
      .toBe("ctx.rlhHomePath('subagent-activation-leases.sqlite3')")
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.RLH_TELEMETRY_MODE || 'DISABLED'",
    })
    const legacyCredentialsPath = rows.find(row => row.id === 'credentials')
      ?.config?.['legacyDesktopJsonPath'] as { __jsExpr: string }
    expect(evaluate({ process: { env: {} } }, legacyCredentialsPath.__jsExpr)).toBeUndefined()
    expect(evaluate({ process: { env: { RLH_DESKTOP_LEGACY_CREDENTIALS_PATH: '/desktop/credentials.json' } } }, legacyCredentialsPath.__jsExpr))
      .toBe('/desktop/credentials.json')
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'workflow-worker-thread')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'tool-workflow')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'tool-ralph')).toHaveLength(1)
    expect(manifest.dependencies).not.toHaveProperty('@relay-harness/rlh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@relay-harness/rlh-subagent-claude-code')
    expect(manifest.dependencies).not.toHaveProperty('@relay-harness/rlh-tool-workflow')
    expect(manifest.dependencies).toHaveProperty('@relay-harness/rlh-workflow-worker-thread')
    expect(manifest.dependencies).toHaveProperty('@relay-harness/rlh-tool-ralph')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
