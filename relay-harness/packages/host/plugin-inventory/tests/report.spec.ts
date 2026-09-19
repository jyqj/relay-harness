/**
 * The capability report joins composed bundle rows, the Loader inventory, and
 * the session tool registry into per-level facts — and never folds `installed`
 * forward into `healthy` or `running`.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPABILITY_CATALOG } from '../src/catalog.ts'
import { buildCapabilityReport } from '../src/report.ts'
import type { CapabilityComposedEntry, CapabilityReport, CapabilityReportEntry, CapabilityRuntimeEvidence, PluginEntryId, PluginInventoryEntry } from '../src/types.ts'

const routerRow = (config: unknown, disabled = false): CapabilityComposedEntry => ({
  entryId: 'code-index-workspace-router',
  moduleName: '@relay-harness/rlh-code-index-workspace-router',
  disabled,
  config,
  origin: 'cordis.patch.yml',
})

const webSearchRows = (apiKeyEnv: unknown): CapabilityComposedEntry[] => [
  { entryId: 'web-search-deepseek', moduleName: '@relay-harness/rlh-web-search-deepseek', disabled: false, config: { apiKeyEnv } },
  { entryId: 'tool-web', moduleName: '@relay-harness/rlh-tool-web', disabled: false, config: {} },
]

const sessionSearchRow = (openAt: unknown): CapabilityComposedEntry => ({
  entryId: 'session-query-sqlite',
  moduleName: '@relay-harness/rlh-session-query-sqlite',
  disabled: false,
  config: { openAt },
})

const inventoryEntry = (overrides: Omit<Partial<PluginInventoryEntry>, 'entryId'> & { entryId: string }): PluginInventoryEntry => ({
  moduleName: `module:${overrides.entryId}`,
  enabled: true,
  fiberPhase: 'active',
  ...overrides,
  entryId: overrides.entryId as PluginEntryId,
})

const runtime = (overrides: {
  inventory?: PluginInventoryEntry[]
  toolNames?: string[] | null
} = {}): CapabilityRuntimeEvidence => ({
  inventory: { entries: overrides.inventory ?? [] },
  ...(overrides.toolNames === null ? {} : { toolNames: overrides.toolNames ?? [] }),
})

const find = (report: CapabilityReport, id: string): CapabilityReportEntry => {
  const entry = report.capabilities.find(capability => capability.capabilityId === id)
  if (entry === undefined) throw new Error(`capability not in report: ${id}`)
  return entry
}

describe('buildCapabilityReport', () => {
  it('reports a capability absent from the composed bundle as absent', () => {
    const report = buildCapabilityReport({ composed: [] })
    const entry = find(report, 'code-index')
    expect(entry.assembled.status).toBe('no')
    expect(entry.assembled.reason).toContain('code-index-workspace-router')
    expect(entry.effective).toBe('absent')
  })

  it('says installed-but-unconfigured exactly: semantic search is NOT running', () => {
    // The shipped base composition mounts the router with no embedding section.
    const report = buildCapabilityReport({ composed: [routerRow({ watcherEnabled: true })] })
    const entry = find(report, 'code-index')
    expect(entry.assembled.status).toBe('yes')
    expect(entry.configured.status).toBe('no')
    expect(entry.configured.reason).toContain('embedding')
    expect(entry.healthy.status).not.toBe('yes')
    expect(entry.effective).toBe('installed')
  })

  it('marks configured yes when the embedding endpoint is fully configured', () => {
    const embedding = { baseURL: 'https://api.example.com/v1', model: 'embed-v1', dimensions: 1024 }
    const report = buildCapabilityReport({
      composed: [routerRow({ embedding }), sessionSearchRow('never'), ...webSearchRows('DEEPSEEK_API_KEY')],
    })
    expect(find(report, 'code-index').configured.status).toBe('yes')
    // An empty-string endpoint value is the same documented off switch.
    const empty = buildCapabilityReport({
      composed: [routerRow({ embedding: { ...embedding, model: '  ' } })],
    })
    expect(find(empty, 'code-index').configured.status).toBe('no')
  })

  it('treats the shipped openAt "never" default as unconfigured full-text search', () => {
    expect(find(buildCapabilityReport({ composed: [sessionSearchRow('never')] }), 'session-full-text-search').configured.status).toBe('no')
    // The plugin default ('startup') applies when the key is absent.
    expect(find(buildCapabilityReport({ composed: [sessionSearchRow(undefined)] }), 'session-full-text-search').configured.status).toBe('yes')
  })

  it('rejects a disabled composed row at the healthy level without runtime evidence', () => {
    const report = buildCapabilityReport({
      composed: [
        routerRow({ embedding: { baseURL: 'https://api.example.com/v1', model: 'embed-v1' } }, true),
      ],
    })
    const entry = find(report, 'code-index')
    expect(entry.healthy.status).toBe('no')
    expect(entry.healthy.reason).toContain('disabled')
    expect(entry.effective).toBe('standby')
  })

  it('reports runtime levels as unknown in a boot-free dump', () => {
    const report = buildCapabilityReport({
      composed: [routerRow({ embedding: { baseURL: 'https://api.example.com/v1', model: 'embed-v1' } })],
    })
    const entry = find(report, 'code-index')
    expect(entry.healthy.status).toBe('unknown')
    expect(entry.sessionAvailable.status).toBe('unknown')
    expect(entry.effective).toBe('standby')
  })

  it('joins inventory fiber state and the session toolset into running', () => {
    const composed = [
      routerRow({ embedding: { baseURL: 'https://api.example.com/v1', model: 'embed-v1' } }),
      ...webSearchRows('DEEPSEEK_API_KEY'),
    ]
    const report = buildCapabilityReport({
      composed,
      runtime: runtime({
        inventory: [
          inventoryEntry({ entryId: 'code-index-workspace-router' }),
          inventoryEntry({ entryId: 'web-search-deepseek' }),
          inventoryEntry({ entryId: 'tool-web' }),
        ],
        toolNames: ['search_code_index', 'web_search'],
      }),
    })
    expect(find(report, 'code-index').effective).toBe('running')
    expect(find(report, 'web-search').effective).toBe('running')
    expect(find(report, 'code-index').healthy.evidence).toContain('plugin inventory')
    expect(find(report, 'code-index').sessionAvailable.evidence).toContain('toolset')
  })

  it('keeps healthy honest against failed and inactive fibers', () => {
    const composed = [routerRow({ embedding: { baseURL: 'https://api.example.com/v1', model: 'embed-v1' } })]
    const failed = buildCapabilityReport({
      composed,
      runtime: runtime({
        inventory: [inventoryEntry({ entryId: 'code-index-workspace-router', fiberPhase: 'failed' })],
        toolNames: ['search_code_index'],
      }),
    })
    expect(find(failed, 'code-index').healthy.status).toBe('no')
    expect(find(failed, 'code-index').effective).toBe('standby')
    const disabledInLoader = buildCapabilityReport({
      composed,
      runtime: runtime({
        inventory: [inventoryEntry({ entryId: 'code-index-workspace-router', enabled: false, fiberPhase: null })],
        toolNames: ['search_code_index'],
      }),
    })
    expect(find(disabledInLoader, 'code-index').healthy.status).toBe('no')
  })

  it('marks session-available no when the composed toolset lacks the capability tools', () => {
    const report = buildCapabilityReport({
      composed: webSearchRows('DEEPSEEK_API_KEY'),
      runtime: runtime({
        inventory: [
          inventoryEntry({ entryId: 'web-search-deepseek' }),
          inventoryEntry({ entryId: 'tool-web' }),
        ],
        toolNames: ['web_search'],
      }),
    })
    const entry = find(report, 'code-index')
    expect(entry.assembled.status).toBe('no')
    expect(entry.effective).toBe('absent')
    const webSearch = find(report, 'web-search')
    expect(webSearch.sessionAvailable.status).toBe('yes')
    const noTools = buildCapabilityReport({
      composed: webSearchRows('DEEPSEEK_API_KEY'),
      runtime: runtime({ inventory: [...runtime().inventory.entries], toolNames: null }),
    })
    expect(find(noTools, 'web-search').sessionAvailable.status).toBe('unknown')
  })

  it('never folds installed forward: every running entry has all four levels yes', () => {
    for (const configured of [true, false]) {
      const composed = [
        routerRow(configured ? { embedding: { baseURL: 'https://api.example.com/v1', model: 'm' } } : {}),
        ...webSearchRows(configured ? 'KEY' : ''),
        sessionSearchRow(configured ? 'first-search' : 'never'),
      ]
      const report = buildCapabilityReport({ composed })
      for (const entry of report.capabilities) {
        if (entry.effective === 'running') {
          expect(entry.assembled.status).toBe('yes')
          expect(entry.configured.status).toBe('yes')
          expect(entry.healthy.status).toBe('yes')
          expect(entry.sessionAvailable.status).toBe('yes')
        }
        if (entry.configured.status !== 'yes') {
          expect(entry.effective === 'installed' || entry.effective === 'absent').toBe(true)
        }
      }
    }
  })

  it('reports catalog ids and labels in catalog order', () => {
    const report = buildCapabilityReport({ composed: [] })
    expect(report.capabilities.map(entry => entry.capabilityId)).toEqual(
      DEFAULT_CAPABILITY_CATALOG.map(definition => definition.id),
    )
  })
})
