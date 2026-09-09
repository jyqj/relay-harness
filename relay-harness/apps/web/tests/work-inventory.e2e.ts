/** Keyless assembled Work regression over a durable inventory older than the initial history page. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page, Response } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@relay-harness/rlh-llm'
import { Session, SessionId } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-session-title'
import type {} from '@relay-harness/rlh-host-apiproxy'
import type { WorkAcceptReceipt, WorkLibraryPage, WorkOpenRequest } from '@relay-harness/rlh-host-work-results/types'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const ID = 'work-whole-inventory'
const LAST = 'WORK_INVENTORY_LAST_TURN'
const OTHER_ID = 'work-library-other'
const ACCEPT_ID = 'work-confirmation-cold'
const ACCEPT_LAST = 'WORK_CONFIRMATION_LAST_TURN'
const NEW_REPLY = 'WORK_AFTER_CONFIRMATION_NEW_REPLY'

/** The old write is followed by 60 complete turns, so it cannot fit in the initial 50-message tail. */
function fixture(options: { id?: string; title?: string; path?: string; turns?: number; marker?: string } = {}): string {
  const id = options.id ?? ID
  const turns = options.turns ?? 61
  const path = options.path ?? 'early.md'
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `${id} Task ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title: options.title ?? 'Whole Work inventory', messageSeqs: [user.seq], source: { kind: 'fallback' } })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      const callId = CallId('old-write')
      const args = JSON.stringify({ file_path: path, content: 'created' })
      session.append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'write', arguments: args }], source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
      }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'write', arguments: args })
      session.append('tool/result', {
        turn, step: 1, producedFiles: [path],
        message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'created' }] }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      session.append('step/end', { turn, step: 1 })
      session.append('step/start', { turn, step: 2 })
    }
    const closingStep = turn === 1 ? 2 : 1
    session.append('assistant/message', {
      turn, step: closingStep,
      message: createAssistantMessage({ content: [{ type: 'text', text: turn === turns ? options.marker ?? LAST : `Done ${turn}` }], source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: closingStep })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [JSON.stringify({ type: 'session', ...session.header, id: '{{sessionId}}', cwd: '{{cwd}}' }), ...session.events.map(event => JSON.stringify(event)), ''].join('\n')
}

/** Navigate through the shipped sidebar instead of materializing the target Agent in a fixture. */
async function selectSeed(page: Page, id: string, marker: string): Promise<void> {
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  const toggle = page.getByRole('button', { name: 'Search sessions', exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(`${id} Task 1`)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await result.waitFor({ state: 'visible', timeout: 30_000 })
  expect(await result.count()).toBe(1)
  await result.click()
  await page.getByText(marker, { exact: true }).waitFor({ timeout: 15_000 })
}

async function remoteValue<T>(response: Response): Promise<T> {
  expect(response.status()).toBe(200)
  const body = await response.json() as { result: { ok: boolean; value?: T; error?: unknown } }
  if (!body.result.ok || body.result.value === undefined) throw new Error(`real Work Remote refused: ${JSON.stringify(body.result)}`)
  return body.result.value
}

describe('web e2e: whole-session Work inventory', () => {
  let scaffold: WebScaffold
  let temporary: string
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'rlh-work-browser-'))
    const overlay = join(temporary, 'work.overlay.yml')
    const replayOverride = join(temporary, 'replay.override.json')
    await writeFile(overlay, '- id: work-results\n  config:\n    scanSessionsPerPage: 1\n    defaultResultsPerPage: 1\n')
    await writeFile(replayOverride, JSON.stringify([{ kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: NEW_REPLY },
      { type: 'block-end', index: 0, block: { type: 'text', text: NEW_REPLY } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture: join(temporary, 'override-only.jsonl'), replayOverride })
    await seedSession(scaffold, fixture(), ID)
    for (const path of ['early.md', 'other-source.txt', 'reviewed.txt']) await writeFile(join(scaffold.workspaceCwd, path), 'created')
    expect(scaffold.ctx.agents.get(SessionId(ID)) === undefined).toBe(true)
    expect(scaffold.ctx.agents.get(SessionId(ACCEPT_ID)) === undefined).toBe(true)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1280, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await selectSeed(page, ID, LAST)
    // Seed this target only after boot has selected its initial session.
    await seedSession(scaffold, fixture({ id: OTHER_ID, title: 'Other source work', path: 'other-source.txt', turns: 1, marker: 'OTHER_WORK_DONE' }), OTHER_ID)
    await seedSession(scaffold, fixture({ id: ACCEPT_ID, title: 'Cold confirmation work', path: 'reviewed.txt', turns: 1, marker: ACCEPT_LAST }), ACCEPT_ID)
    expect(scaffold.ctx.agents.get(SessionId(ACCEPT_ID)) === undefined).toBe(true)
  }, 120_000)
  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
    }
  })

  it('shows an older-than-page output after reload and handles Host refusal through the real carrier', async () => {
    await selectSeed(page, ID, LAST)
    expect(await page.getByText('Done 1', { exact: true }).count()).toBe(0)
    await page.getByRole('tab', { name: 'Work', exact: true }).click()
    await page.getByRole('button', { name: 'early.md', exact: true }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('tab', { name: 'Work', exact: true }).click()
    await page.getByRole('button', { name: 'early.md', exact: true }).waitFor({ timeout: 15_000 })
    expect(await page.getByRole('button', { name: 'early.md', exact: true }).ariaSnapshot()).toBe('- button "early.md"')
    const open = vi.spyOn(scaffold.ctx.apiProxy.host, 'openPath').mockImplementation(async request => ({
      rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'path open failed: file removed', details: {} } },
    }))
    try {
      await page.getByRole('button', { name: 'early.md', exact: true }).click()
      await page.getByRole('alert').getByText('Open failed:', { exact: false }).waitFor()
      expect(await page.getByRole('alert').ariaSnapshot()).toBe(`- alert:
  - paragraph: "Open failed: path open failed: file removed"
  - button "Retry"
  - button "Dismiss"`)
      expect(open).toHaveBeenCalledTimes(1)
      expect(open.mock.calls[0]?.[0].payload).toEqual({ path: await realpath(join(scaffold.workspaceCwd, 'early.md')) })
    } finally { open.mockRestore() }
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('queries and pages cross-session outputs without activating their owners, and preserves the selected source on open', async () => {
    expect(scaffold.ctx.agents.get(SessionId(OTHER_ID)) === undefined).toBe(true)
    expect(scaffold.ctx.agents.get(SessionId(ACCEPT_ID)) === undefined).toBe(true)
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workResults/list')
    await page.getByRole('tab', { name: 'Library', exact: true }).click()
    const pages = [await remoteValue<WorkLibraryPage>(await firstResponse)]
    while (pages.at(-1)?.next !== null && pages.length < 10) {
      const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workResults/list')
      await page.getByRole('button', { name: 'Continue search', exact: true }).click()
      pages.push(await remoteValue<WorkLibraryPage>(await nextResponse))
    }
    expect(pages.length).toBeGreaterThanOrEqual(3)
    expect(pages.every(value => value.scannedSessions === 1 && value.entries.length <= 1)).toBe(true)
    expect(pages.at(-1)?.next).toBeNull()
    expect(pages.flatMap(value => value.entries).map(value => [value.sessionId, value.path]).sort())
      .toEqual([[ID, 'early.md'], [OTHER_ID, 'other-source.txt'], [ACCEPT_ID, 'reviewed.txt']].sort())
    expect(scaffold.ctx.agents.get(SessionId(OTHER_ID)) === undefined).toBe(true)
    expect(scaffold.ctx.agents.get(SessionId(ACCEPT_ID)) === undefined).toBe(true)
    const open = vi.spyOn(scaffold.ctx.apiProxy.host, 'openPath').mockImplementation(async request => ({
      rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'Host policy denied this output', details: {} } },
    }))
    try {
      const opened = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workResults/open')
      await page.getByRole('button', { name: 'other-source.txt', exact: true }).click()
      const response = await opened
      const request = response.request().postDataJSON() as { payload: { args: { request: WorkOpenRequest } } }
      expect(request.payload.args.request).toEqual({ sessionId: OTHER_ID, path: 'other-source.txt' })
      await page.getByRole('alert').filter({ hasText: 'Host policy denied this output' }).waitFor()
      expect(open.mock.calls[0]?.[0].payload.path).toBe(await realpath(join(scaffold.workspaceCwd, 'other-source.txt')))
    } finally { open.mockRestore() }
    await page.getByRole('textbox', { name: 'Search output filenames', exact: true }).fill('other-source')
    const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workResults/list')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const filtered = [await remoteValue<WorkLibraryPage>(await searched)]
    while (filtered.at(-1)?.next !== null && filtered.length < 10) {
      const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workResults/list')
      await page.getByRole('button', { name: 'Continue search', exact: true }).click()
      filtered.push(await remoteValue<WorkLibraryPage>(await nextResponse))
    }
    expect(filtered.flatMap(value => value.entries)).toEqual([expect.objectContaining({ sessionId: OTHER_ID, path: 'other-source.txt' })])
    expect(await page.getByRole('button', { name: 'early.md', exact: true }).count()).toBe(0)
    expect(scaffold.ctx.agents.get(SessionId(OTHER_ID)) === undefined).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('confirms a cold historical Work through the real Agent lookup, retains its durable receipt after reload, and invalidates it on new work', async () => {
    // The target has never been selected or materialized by a fixture. Any
    // live resolution must happen through the shipped client/Remote path.
    expect(scaffold.ctx.agents.get(SessionId(ACCEPT_ID)) === undefined).toBe(true)
    await selectSeed(page, ACCEPT_ID, ACCEPT_LAST)
    await page.getByRole('tab', { name: 'Work', exact: true }).click()
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workResults/accept')
    await page.getByRole('button', { name: 'Confirm current result', exact: true }).click()
    const receipt = await remoteValue<WorkAcceptReceipt>(await accepted)
    expect(receipt.current).toBe(true)
    expect(scaffold.ctx.agents.get(SessionId(ACCEPT_ID))).toBeDefined()
    await page.getByText('Current transcript confirmed', { exact: true }).waitFor({ timeout: 15_000 })
    const persisted = await scaffold.ctx.sessionPersistence.readFrom(SessionId(ACCEPT_ID), 0)
    expect(persisted.events.filter(event => event.type === 'work/accepted')).toEqual([
      expect.objectContaining({ seq: receipt.recordedSeq, data: { reviewedThroughSeq: receipt.reviewedThroughSeq, actor: 'host-client' } }),
    ])
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('tab', { name: 'Work', exact: true }).click()
    await page.getByText('Current transcript confirmed', { exact: true }).waitFor({ timeout: 15_000 })
    const settled = scaffold.whenTurnSettled(30_000)
    await page.locator('textarea:enabled').last().fill('Record another result after my confirmation.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(ACCEPT_ID)
    await page.getByText(NEW_REPLY, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText('Results changed; confirm again', { exact: true }).waitFor({ timeout: 15_000 })
    const changed = await scaffold.ctx.sessionPersistence.readFrom(SessionId(ACCEPT_ID), 0)
    expect(changed.events.filter(event => event.type === 'work/accepted')).toHaveLength(1)
    expect(changed.events.findLast(event => event.type === 'turn/end')?.seq).toBeGreaterThan(receipt.recordedSeq)
    expect(changed.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === NEW_REPLY))).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

})
