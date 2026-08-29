import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@relay-harness/rlh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@relay-harness/rlh-llm-replay'
import type {} from '@relay-harness/rlh-memory'
import type { SessionEvent } from '@relay-harness/rlh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIRST_PROMPT = 'Remember that browser acceptance must stay explicit.'
const DRAFT = 'improve browser acceptance prompt enhance e2e'
const ENHANCED = 'Improve Prompt Enhancement and verify its real browser acceptance flow without submitting it.'
const STALE_DRAFT = 'second enhancement attempt'

function textEntry(text: string, pieces = 1): ReplayEntry {
  const points = Array.from(text)
  const size = Math.ceil(points.length / pieces)
  const deltas = Array.from({ length: pieces }, (_, index) => points.slice(index * size, (index + 1) * size).join(''))
    .filter(Boolean)
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(part => ({ type: 'text-delta' as const, index: 0, text: part })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 32, outputTokens: 32 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return { kind: 'chunks', chunks }
}

function enhancementOutput(enhancedDraft: string): string {
  return JSON.stringify({
    enhancedDraft,
    assumptions: ['The shipped browser composition remains authoritative.'],
    openQuestions: [],
  })
}

function replayScript(): ReplayOverrideDoc {
  return [
    textEntry('PRIOR_HISTORY_DONE'),
    textEntry(enhancementOutput(ENHANCED), 4),
    textEntry(enhancementOutput('This cancelled proposal must not overwrite the live editor.'), 60),
  ]
}

describe('web e2e: ordinary product shell and Prompt Enhancement', () => {
  let replayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'rlh-prompt-enhancement-e2e-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(replayScript()))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      paceMs: 25,
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'product-shell-prompt-context')
    const workspace = join(scaffold.workspaceCwd, 'product-shell-prompt-context')
    const session = scaffold.ctx.sessions.list().find(item => item.header.cwd === workspace)
    if (session === undefined) throw new Error('Prompt Enhancement e2e did not attach its workspace Session')
    await scaffold.ctx.longTermMemory.remember({
      scope: {
        workspaceId: workspace,
        userId: process.env.USER || process.env.USERNAME || 'local',
        agentId: 'relay-harness',
      },
      kind: 'preference',
      content: 'Browser acceptance must stay explicit.',
      importance: 4,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [{
        sessionId: session.id,
        eventSeqs: [0],
        verification: 'user-statement',
        excerpt: 'browser acceptance must stay explicit',
      }],
    })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Prompt Enhancement e2e cleanup failed')
  })

  it('runs draft → real Remote enhance → source explanation → diff → accept → undo without auto-submit, and cancels in flight', async () => {
    onTestFailed(() => saveFailureShot(page, 'product-shell-prompt-context'))
    const composer = page.locator('textarea:enabled').last()
    await composer.waitFor({ timeout: 15_000 })

    await expect(page.getByRole('button', { name: 'Enhance prompt' }).count()).resolves.toBe(1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const mode = page.getByRole('dialog', { name: 'Settings' }).getByRole('switch', { name: 'Developer Mode' })
    await mode.waitFor()
    expect(await mode.isChecked()).toBe(false)
    await page.keyboard.press('Escape')

    await composer.fill(FIRST_PROMPT)
    const settled = scaffold.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await settled
    await page.getByText('PRIOR_HISTORY_DONE', { exact: true }).waitFor()
    const directMessagesAfterTurn = events.filter(event => (
      event.type === 'user/message' && event.data.source.kind === 'user'
    )).length
    expect(directMessagesAfterTurn).toBe(1)
    const inspectContext = page.getByRole('button', { name: 'Inspect context used for this session' })
    await expect.poll(() => inspectContext.textContent(), { timeout: 10_000 }).toMatch(/^Context [1-9]\d*$/u)
    await inspectContext.click()
    const inspector = page.getByRole('dialog', { name: 'Context Inspector' })
    await inspector.getByText(/context\/prepared #/u).first().waitFor({ timeout: 10_000 })
    await inspector.getByText(/Model-admitted|Rejected or rewritten/u).first().waitFor({ timeout: 10_000 })
    await inspector.getByRole('button', { name: 'Close', exact: true }).last().click()

    await composer.fill(DRAFT)
    await page.getByRole('button', { name: 'Enhance prompt' }).click()
    const proposal = page.getByRole('dialog', { name: 'Enhancement proposal' })
    await proposal.waitFor({ timeout: 30_000 })
    await expect(proposal.getByText(DRAFT, { exact: true }).count()).resolves.toBeGreaterThan(0)
    await expect(proposal.getByText(ENHANCED, { exact: true }).count()).resolves.toBeGreaterThan(0)
    const sources = proposal.getByRole('region', { name: 'Sources used this time' })
    await sources.waitFor()
    await proposal.getByText('History', { exact: true }).first().waitFor()
    await proposal.getByText('Memory', { exact: true }).first().waitFor()
    await expect.poll(() => sources.textContent()).toContain('Freshness: Current')
    await expect.poll(() => sources.textContent()).toContain('Verification: Verified')
    await proposal.getByText(/completed-turn/).first().waitFor()
    expect(await composer.inputValue()).toBe(DRAFT)

    await proposal.getByRole('button', { name: 'Accept enhancement' }).click()
    await expect.poll(() => composer.inputValue()).toBe(ENHANCED)
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)

    await page.getByRole('button', { name: 'Undo enhancement' }).click()
    await expect.poll(() => composer.inputValue()).toBe(DRAFT)
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)

    await composer.fill(STALE_DRAFT)
    await page.getByRole('button', { name: 'Enhance prompt' }).click()
    const cancel = page.getByRole('button', { name: 'Cancel prompt enhancement' })
    await cancel.waitFor()
    await cancel.click()
    await page.getByRole('button', { name: 'Enhance prompt' }).waitFor()
    expect(await composer.inputValue()).toBe(STALE_DRAFT)
    expect(await page.getByRole('dialog', { name: 'Enhancement proposal' }).count()).toBe(0)
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.filter(event => (
      (event as { readonly type: string }).type === 'prompt-enhancement/llm-request'
    )).length).toBeGreaterThanOrEqual(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
