// Web e2e scenario: the shipped Settings composition reaches the real MCP,
// Skills, Memory, and Code Index surfaces through browser gestures. The world
// is keyless and isolated under the scaffold's temporary roots. Its managed
// MCP mutation remains disabled and is deleted without starting a subprocess.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFailed } from 'vitest'
import type { LongTermMemory } from '@relay-harness/rlh-memory'
import type { SessionStore } from '@relay-harness/rlh-session'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-catalog-pages', import.meta.url))
const MCP_EXPECTED = join(SNAPSHOT_DIR, 'mcp.expected.md')
const SKILLS_EXPECTED = join(SNAPSHOT_DIR, 'skills.expected.md')
const MEMORY_VALIDATION_EXPECTED = join(SNAPSHOT_DIR, 'memory-validation.expected.md')
const FIXTURE_SKILL = 'settings-catalog-fixture'
const SCAFFOLD_MODULE = './scaffold.ts'

type SnapshotMode = 'replay' | 'record' | 'refresh'

interface CatalogScaffold {
  readonly baseUrl: string
  readonly ctx: {
    readonly longTermMemory: LongTermMemory
    readonly sessions: SessionStore
  }
  readonly harnessHome: string
  readonly workspaceCwd: string
  close(): Promise<void>
}

interface ScaffoldApi {
  launchWebScaffold(options?: object): Promise<CatalogScaffold>
  webSnapshotMode(): SnapshotMode
  captureStableAria(page: Page, selector: string, workspaceCwd: string): Promise<string>
  compareOrRefreshGolden(path: string, actual: string, mode: SnapshotMode): Promise<void>
  assertFixtureInventory(path: string, expected: string[]): Promise<void>
  watchConsole(page: Page): { warnings: string[]; pageErrors: string[] }
}

describe('web e2e: shipped Settings catalogs and centers', () => {
  it.skipIf(process.env.RLH_SNAPSHOT === 'record')('drives real MCP and Skill mutations plus Memory and Code Index Remote flows', async () => {
    const scaffoldApi = await import(SCAFFOLD_MODULE) as ScaffoldApi
    const mode = scaffoldApi.webSnapshotMode()
    let scaffold: CatalogScaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    try {
      scaffold = await scaffoldApi.launchWebScaffold({
        bundledSkills: [{
          name: FIXTURE_SKILL,
          markdown: [
            '---',
            `name: ${FIXTURE_SKILL}`,
            'description: Deterministic skill for Settings composition coverage',
            'whenToUse: Use only in the isolated Web scaffold test',
            'disable-model-invocation: true',
            'user-invocable: false',
            '---',
            '',
            'Keep this fixture inside the temporary scaffold world.',
            '',
          ].join('\n'),
        }],
      })
      expect(scaffold.harnessHome.startsWith(scaffold.workspaceCwd)).toBe(true)
      const workspace = join(scaffold.workspaceCwd, 'settings-catalog')
      const importSource = join(scaffold.workspaceCwd, 'settings-import-source')
      await Promise.all([mkdir(workspace, { recursive: true }), mkdir(importSource, { recursive: true })])
      await Promise.all([
        writeFile(join(workspace, 'only-code-index-center.ts'), 'export const codeIndexCenterE2eNeedle = 1\n'),
        writeFile(join(importSource, 'SKILL.md'), [
          '---',
          'name: imported-settings-e2e',
          'description: Imported through the real Settings Remote',
          'disable-model-invocation: true',
          'user-invocable: false',
          '---',
          '',
          'Keep this imported fixture inside the temporary scaffold world.',
          '',
        ].join('\n')),
      ])

      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      const tripwire = scaffoldApi.watchConsole(page)
      onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-e2e-settings-catalog-pages') })

      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'settings-catalog')
      const attached = scaffold.ctx.sessions.list().find(session => session.header.cwd === workspace)
      if (attached === undefined) throw new Error('Settings catalog browser did not attach its workspace Session')
      const memoryScope = {
        workspaceId: workspace,
        userId: process.env.USER || process.env.USERNAME || 'local',
        agentId: 'relay-harness',
      }
      const candidate = await scaffold.ctx.longTermMemory.remember({
        scope: memoryScope,
        kind: 'preference',
        content: 'Always expose governed memory evidence in product flows.',
        importance: 4,
        confidence: 0.8,
        trust: 'agent-proposed',
        status: 'candidate',
        evidence: [{
          sessionId: attached.id,
          eventSeqs: [0],
          verification: 'agent-proposal',
          excerpt: 'governed memory evidence',
        }],
      })
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })

      const mcpNav = dialog.getByRole('button', { name: 'MCP', exact: true })
      const skillsNav = dialog.getByRole('button', { name: 'Skills', exact: true })
      await mcpNav.click()
      await dialog.getByRole('heading', { name: 'MCP servers', exact: true }).waitFor({ timeout: 10_000 })
      await dialog.getByRole('searchbox', { name: 'Search name, ID, command, or URL' }).waitFor({ timeout: 10_000 })
      expect(await mcpNav.getAttribute('aria-current')).toBe('true')
      expect(await skillsNav.getAttribute('aria-current')).toBeNull()
      expect(await dialog.getByRole('alert').count()).toBe(0)
      const mcpSnapshot = await scaffoldApi.captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      await scaffoldApi.compareOrRefreshGolden(MCP_EXPECTED, mcpSnapshot, mode)

      await skillsNav.click()
      await dialog.getByRole('heading', { name: 'Skills', exact: true }).waitFor({ timeout: 10_000 })
      try {
        await dialog.getByText(FIXTURE_SKILL, { exact: true }).waitFor({ timeout: 10_000 })
      } catch (error) {
        const state = await scaffoldApi.captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
        throw new Error(`fixture skill did not resolve through the active preset:\n${state}`, { cause: error })
      }
      expect(await skillsNav.getAttribute('aria-current')).toBe('true')
      expect(await mcpNav.getAttribute('aria-current')).toBeNull()
      expect(await dialog.getByRole('alert').count()).toBe(0)
      const skillsSnapshot = await scaffoldApi.captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      await scaffoldApi.compareOrRefreshGolden(SKILLS_EXPECTED, skillsSnapshot, mode)

      await dialog.getByRole('button', { name: 'Import', exact: true }).click()
      const importDialog = page.getByRole('dialog', { name: 'Import skill' })
      await importDialog.getByPlaceholder('Path or repository URL').fill(importSource)
      await importDialog.getByRole('button', { name: 'Import skill', exact: true }).click()
      await dialog.getByText('imported-settings-e2e', { exact: true }).waitFor({ timeout: 10_000 })

      await mcpNav.click()
      await dialog.getByRole('button', { name: 'Add server' }).click()
      const mcpEditor = page.getByRole('dialog', { name: 'Add MCP server' })
      await mcpEditor.getByRole('button', { name: 'JSON', exact: true }).click()
      await mcpEditor.getByLabel('Server JSON').fill(JSON.stringify({
        settings_e2e: {
          id: 'settings-e2e',
          enabled: false,
          transport: 'stdio',
          serverName: 'settings_e2e',
          command: 'node',
        },
      }))
      await mcpEditor.getByRole('button', { name: 'Save', exact: true }).click()
      try {
        await dialog.getByText('settings_e2e', { exact: true }).waitFor({ timeout: 10_000 })
      } catch (error) {
        const state = await scaffoldApi.captureStableAria(page, 'body', scaffold.workspaceCwd)
        throw new Error(`managed MCP server did not appear after save:\n${state}`, { cause: error })
      }
      await dialog.getByRole('button', { name: 'Delete settings_e2e' }).click()
      const deleteMcp = page.getByRole('dialog', { name: 'Delete settings_e2e?' })
      await deleteMcp.getByRole('button', { name: 'Confirm delete' }).click()
      await expect.poll(() => dialog.getByText('settings_e2e', { exact: true }).count(), { timeout: 10_000 }).toBe(0)

      await dialog.getByRole('button', { name: 'Memory', exact: true }).click()
      await dialog.getByRole('heading', { name: 'Memory Center', exact: true }).waitFor({ timeout: 10_000 })
      const memoryRow = dialog.getByText('Always expose governed memory evidence in product flows.', { exact: true })
      await memoryRow.click()
      const memoryDetails = page.getByRole('dialog', { name: 'Details' })
      await memoryDetails.getByText('Always expose governed memory evidence in product flows.', { exact: true })
        .waitFor({ timeout: 10_000 })
      await memoryDetails.getByRole('button', { name: 'Approve', exact: true }).click()
      await memoryDetails.getByText('Active', { exact: true }).waitFor({ timeout: 10_000 })
      await expect.poll(async () => (await scaffold!.ctx.longTermMemory.read(memoryScope, candidate.id))?.status)
        .toBe('active')
      const approved = await scaffold.ctx.longTermMemory.read(memoryScope, candidate.id)
      expect(approved).toBeDefined()
      await memoryDetails.getByRole('button', { name: 'Revise', exact: true }).click()
      await memoryDetails.getByLabel('Confidence', { exact: true }).fill('')
      await memoryDetails.getByRole('button', { name: 'Save revision', exact: true }).click()
      await memoryDetails.getByRole('alert').getByText(
        'Enter valid importance, confidence, and a future expiry time.', { exact: true },
      ).waitFor({ timeout: 10_000 })
      await scaffoldApi.compareOrRefreshGolden(
        MEMORY_VALIDATION_EXPECTED, await memoryDetails.getByRole('alert').ariaSnapshot(), mode,
      )
      expect(await scaffold.ctx.longTermMemory.read(memoryScope, candidate.id)).toEqual(approved)
      await memoryDetails.getByLabel('Confidence', { exact: true }).fill('0')
      await expect.poll(() => memoryDetails.getByRole('alert').count()).toBe(0)
      await memoryDetails.getByRole('button', { name: 'Save revision', exact: true }).click()
      await memoryDetails.getByRole('button', { name: 'Revise', exact: true }).waitFor({ timeout: 10_000 })
      await expect.poll(async () => (await scaffold!.ctx.longTermMemory.read(memoryScope, candidate.id))?.confidence)
        .toBe(0)
      expect((await scaffold.ctx.longTermMemory.read(memoryScope, candidate.id))?.revision)
        .toBe((approved?.revision ?? 0) + 1)
      await memoryDetails.getByRole('button', { name: 'Close', exact: true }).last().click()

      await dialog.getByRole('button', { name: 'Code Index', exact: true }).click()
      await dialog.getByRole('heading', { name: 'Code Index Center', exact: true }).waitFor({ timeout: 10_000 })
      await dialog.getByText(workspace, { exact: false }).waitFor({ timeout: 10_000 })
      const refreshIndex = dialog.getByRole('button', { name: 'Refresh index', exact: true })
      await refreshIndex.click()
      await expect.poll(() => refreshIndex.isEnabled(), { timeout: 10_000 }).toBe(true)
      await dialog.getByPlaceholder('Enter a bounded retrieval query').fill('codeIndexCenterE2eNeedle')
      await dialog.getByRole('button', { name: 'Run', exact: true }).click()
      await dialog.getByText(/only-code-index-center\.ts/u).waitFor({ timeout: 10_000 })

      const forceRebuild = dialog.getByRole('button', { name: 'Force rebuild', exact: true })
      await forceRebuild.click()
      const confirmation = page.getByRole('dialog', { name: 'Confirm force rebuild', exact: true })
      await confirmation.getByLabel('REBUILD', { exact: true }).fill('REBUILD')
      expect(await confirmation.getByRole('button', { name: 'Confirm rebuild', exact: true }).isEnabled()).toBe(true)
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).last().click()
      await expect.poll(() => confirmation.count()).toBe(0)
      await forceRebuild.click()
      expect(await confirmation.getByLabel('REBUILD', { exact: true }).inputValue()).toBe('')
      expect(await confirmation.getByRole('button', { name: 'Confirm rebuild', exact: true }).ariaSnapshot())
        .toMatchInlineSnapshot('"- button \"Confirm rebuild\" [disabled]"')
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).last().click()

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      if (mode !== 'record') {
        await scaffoldApi.assertFixtureInventory(SNAPSHOT_DIR, ['mcp.expected.md', 'skills.expected.md', 'memory-validation.expected.md'])
      }
    } finally {
      await browser?.close()
      await scaffold?.close()
    }
  }, 120_000)
})
