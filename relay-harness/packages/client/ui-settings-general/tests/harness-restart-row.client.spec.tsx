// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@relay-harness/rlh-client-test-runtime'
import { HarnessRestartRow, type HarnessRestartRowProps } from '../src/client/HarnessRestartRow.tsx'
import { HARNESS_RESTART_DEFAULTS } from '../src/client/desktop-shell.ts'
import { en } from '../src/client/locales.ts'

const unusedHook = (() => { throw new Error('unused by HarnessRestartRow') }) as never
const props: HarnessRestartRowProps = { useSessions: unusedHook, useWorkspaces: unusedHook, t: makeTranslate(en) }
const policy = { ...HARNESS_RESTART_DEFAULTS }
const label = (key: 'enable' | 'maxAttempts' | 'baseDelay') => en[`harnessRestart.${key}`]

afterEach(() => { cleanup(); delete (window as Window & { shell?: unknown }).shell })

describe('HarnessRestartRow', () => {
  it('keeps controls disabled until persisted settings arrive and while a patch is pending', async () => {
    const loaded = Promise.withResolvers<typeof policy>()
    const saved = Promise.withResolvers<typeof policy>()
    const saveConfig = vi.fn(() => saved.promise)
    Object.assign(window, { shell: { getConfig: () => loaded.promise, saveConfig } })
    render(<HarnessRestartRow {...props} />)
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: label('enable') })
    expect(toggle.disabled).toBe(true)
    await act(async () => { loaded.resolve(policy); await loaded.promise })
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    expect(toggle.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: label('maxAttempts') }).disabled).toBe(true)
    toggle.click()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledWith({ harnessAutoRestart: false })
    await act(async () => { saved.resolve({ ...policy, harnessAutoRestart: false }); await saved.promise })
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([new Error('Save unavailable'), 'IPC unavailable'])('retains the persisted setting after %j and allows another save', async (failure) => {
    const saveConfig = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ harnessAutoRestart: false })
    Object.assign(window, { shell: { getConfig: async () => policy, saveConfig } })
    render(<HarnessRestartRow {...props} />)
    const toggle = screen.getByRole<HTMLInputElement>('switch')
    await waitFor(() => { expect(toggle.disabled).toBe(false) })
    fireEvent.click(toggle)
    expect((await screen.findByRole('alert')).textContent).toContain(failure instanceof Error ? failure.message : failure)
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => { expect(toggle.checked).toBe(false) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([new Error('Read unavailable'), 'IPC disconnected'])('renders a failed initial read %j', async (failure) => {
    Object.assign(window, { shell: { getConfig: async () => { throw failure }, saveConfig: vi.fn() } })
    render(<HarnessRestartRow {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain(failure instanceof Error ? failure.message : failure)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('saves each picker independently and keeps the other persisted fields', async () => {
    const saveConfig = vi.fn(async () => ({}))
    Object.assign(window, { shell: { getConfig: async () => policy, saveConfig } })
    render(<HarnessRestartRow {...props} />)
    const attempts = screen.getByRole<HTMLButtonElement>('button', { name: label('maxAttempts') })
    await waitFor(() => { expect(attempts.disabled).toBe(false) })
    fireEvent.click(attempts)
    fireEvent.click(await screen.findByRole('menuitem', { name: '5' }))
    await waitFor(() => { expect(attempts.textContent).toContain('5') })
    expect(saveConfig).toHaveBeenLastCalledWith({ harnessRestartMaxAttempts: 5 })
    const delay = screen.getByRole('button', { name: label('baseDelay') })
    fireEvent.click(delay)
    fireEvent.click(await screen.findByRole('menuitem', { name: makeTranslate(en)('harnessRestart.delay', { count: '2' }) }))
    await waitFor(() => { expect(delay.textContent).toContain('2') })
    expect(attempts.textContent).toContain('5')
    expect(saveConfig).toHaveBeenLastCalledWith({ harnessRestartBaseDelayMs: 2000 })
  })
})

it.each(['maxAttempts', 'baseDelay'] as const)('dismisses the %s picker without writing configuration', async (picker) => {
  const saveConfig = vi.fn(async () => policy)
  Object.assign(window, { shell: { getConfig: async () => policy, saveConfig } })
  render(<HarnessRestartRow {...props} />)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: label(picker) })
  await waitFor(() => { expect(button.disabled).toBe(false) })
  fireEvent.click(button)
  expect(await screen.findByRole('menu')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
  expect(saveConfig).not.toHaveBeenCalled()
})

it('stays inert when the desktop bridge is absent', () => {
  render(<HarnessRestartRow {...props} />)
  expect(screen.getByRole<HTMLInputElement>('switch').disabled).toBe(true)
  expect(screen.getByRole('status').textContent).toBe(en['harnessRestart.loading'])
})

it.each(['resolve', 'reject'] as const)('ignores the cancelled StrictMode read when it later %s', async (outcome) => {
  const obsolete = Promise.withResolvers<typeof policy>()
  const getConfig = vi.fn().mockReturnValueOnce(obsolete.promise)
    .mockResolvedValue({ ...policy, harnessAutoRestart: false })
  Object.assign(window, { shell: { getConfig, saveConfig: vi.fn() } })
  render(<StrictMode><HarnessRestartRow {...props} /></StrictMode>)
  const toggle = screen.getByRole<HTMLInputElement>('switch')
  await waitFor(() => { expect(toggle.disabled).toBe(false) })
  expect(toggle.checked).toBe(false)
  expect(getConfig).toHaveBeenCalledTimes(2)
  await act(async () => {
    if (outcome === 'resolve') obsolete.resolve(policy)
    else obsolete.reject(new Error('Obsolete read failure'))
    await obsolete.promise.catch(() => undefined)
  })
  expect(toggle.checked).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('does not report a successful change through a bridge without saveConfig', async () => {
  Object.assign(window, { shell: { getConfig: async () => policy } })
  render(<HarnessRestartRow {...props} />)
  const toggle = screen.getByRole<HTMLInputElement>('switch')
  await waitFor(() => { expect(toggle.disabled).toBe(false) })
  fireEvent.click(toggle)
  expect(toggle.checked).toBe(true)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})
