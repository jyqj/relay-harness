import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFailed } from 'vitest'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SCAFFOLD_MODULE = './scaffold.ts'

interface Scaffold {
  baseUrl: string
  workspaceCwd: string
  close(): Promise<void>
}

describe('web e2e: ordinary product shell and context controls', () => {
  it('keeps provenance and Enhance visible in Simple Mode and navigates real Work/Library pages', async () => {
    const api = await import(SCAFFOLD_MODULE) as {
      launchWebScaffold(): Promise<Scaffold>
      watchConsole(page: Page): { warnings: string[]; pageErrors: string[] }
    }
    let scaffold: Scaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    try {
      scaffold = await api.launchWebScaffold()
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      const tripwire = api.watchConsole(page)
      onTestFailed(() => {
        if (page) void saveFailureShot(page, 'product-shell-prompt-context')
      })
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'product-shell')

      await expect(page.getByRole('button', { name: 'Enhance prompt' }).count()).resolves.toBe(1)
      const boot = await page.evaluate(() => (
        (window as unknown as { __RLH_BOOT__?: { entries?: Array<{ id?: string }> } })
          .__RLH_BOOT__?.entries ?? []
      ).map(item => item.id))
      expect(boot).toContain('@relay-harness/rlh-client-ui-context-inspector')

      await page.getByRole('tab', { name: 'Work', exact: true }).click()
      await page.getByRole('heading', { name: 'Current work', exact: true }).waitFor()
      await page.getByRole('tab', { name: 'Library', exact: true }).click()
      await page.getByRole('heading', { name: 'Library', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      const mode = dialog.getByRole('switch', { name: 'Developer Mode' })
      await mode.waitFor()
      expect(await mode.isChecked()).toBe(false)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await browser?.close()
      await scaffold?.close()
    }
  }, 120_000)
})
