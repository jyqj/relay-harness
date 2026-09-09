// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AboutSection, type AboutSectionProps } from '../src/client/AboutSection.tsx'
import { UpdateAction } from '../src/client/UpdateAction.tsx'
import { en } from '../src/client/locales.ts'
import type { DesktopShell } from '../src/client/desktop-shell.ts'

const t: AboutSectionProps['t'] = (key, values) => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
const unusedHook = (() => { throw new Error('unused by About') }) as never
const props = { close: () => {}, t, useSessions: unusedHook, useWorkspaces: unusedHook }

afterEach(() => {
  cleanup()
  delete (window as Window & { shell?: DesktopShell }).shell
})

it.each(['unavailable', 'current', 'none'] as const)('disables installation for %s even if a stale asset URL exists', async (status) => {
  const install = vi.fn()
  Object.assign(window, { shell: { checkUpdate: async () => ({ status, message: 'signing authority missing', assetUrl: 'https://old.invalid/setup.exe' }), installUpdate: install } })
  render(<AboutSection {...props} />)
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en['about.checkUpdate'] }).disabled).toBe(false) })
  const button = screen.getByRole('button', { name: en['about.installUpdate'] }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(install).not.toHaveBeenCalled()
  if (status === 'unavailable') expect(screen.getByRole('status').textContent).toContain('signing authority missing')
})

it('reports an install-time authority rejection instead of leaving the update dialog downloading forever', async () => {
  Object.assign(window, { shell: {
    checkUpdate: async () => ({ status: 'available', latest: '2.0.0' }),
    installUpdate: async () => ({ status: 'unavailable', launched: false, message: 'signature expired' }),
  } })
  render(<UpdateAction wide t={t} />)
  const open = await screen.findByRole('button')
  fireEvent.click(open)
  const buttons = screen.getAllByRole('button')
  const install = buttons.find(button => button.textContent?.includes(en['update.install']))
  expect(install).toBeDefined()
  fireEvent.click(install!)
  await waitFor(() => { expect(screen.getByText(/signature expired/)).toBeTruthy() })
})
