// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@relay-harness/rlh-client-test-runtime'
import { SimpleModeRow } from '../src/client/SimpleModeRow.tsx'
import type { SimpleModeRowProps } from '../src/client/SimpleModeRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  delete (window as Window & { shell?: unknown }).shell
})

const unusedHook = (() => { throw new Error('unused by SimpleModeRow') }) as never

function props(): SimpleModeRowProps {
  return {
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    t: makeTranslate(en),
  }
}

function mount() {
  render(<SimpleModeRow {...props()} />)
}

describe('SimpleModeRow', () => {
  it('reads the flag off the desktop config and turns it on', async () => {
    const saveConfig = vi.fn(async () => ({ simpleMode: true }))
    ;(window as Window & { shell?: unknown }).shell = {
      getConfig: async () => ({ simpleMode: false }),
      saveConfig,
    }
    mount()
    const toggle = screen.getByRole('switch', { name: 'Simple mode' }) as HTMLInputElement
    await waitFor(() => { expect(toggle.disabled).toBe(false) })
    expect(toggle.checked).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => { fireEvent.click(toggle) })
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: true })
    expect(toggle.checked).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('next time the desktop app starts')
  })

  it('loads an enabled flag and turns it back off', async () => {
    const saveConfig = vi.fn(async () => ({ simpleMode: false }))
    ;(window as Window & { shell?: unknown }).shell = {
      getConfig: async () => ({ simpleMode: true }),
      saveConfig,
    }
    mount()
    const toggle = screen.getByRole('switch', { name: 'Simple mode' }) as HTMLInputElement
    await waitFor(() => { expect(toggle.checked).toBe(true) })

    await act(async () => { fireEvent.click(toggle) })
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: false })
    expect(toggle.checked).toBe(false)
  })

  it.each([
    ['an Error', new Error('unavailable'), 'unavailable'],
    ['a bare value', 'unavailable', 'unavailable'],
  ])('reports a read that rejects with %s', async (_case, rejection, message) => {
    ;(window as Window & { shell?: unknown }).shell = {
      getConfig: async () => { throw rejection },
      saveConfig: async () => ({}),
    }
    mount()
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(message)
    })
  })

  it.each([
    ['an Error', new Error('disk full'), 'disk full'],
    ['a bare value', 'disk full', 'disk full'],
  ])('keeps the old value when the write rejects with %s', async (_case, rejection, message) => {
    ;(window as Window & { shell?: unknown }).shell = {
      getConfig: async () => ({ simpleMode: false }),
      saveConfig: async () => { throw rejection },
    }
    mount()
    const toggle = screen.getByRole('switch', { name: 'Simple mode' }) as HTMLInputElement
    await waitFor(() => { expect(toggle.disabled).toBe(false) })
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.checked).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain(message)
  })

  it('stays inert in a plain browser with no desktop bridge', async () => {
    mount()
    const toggle = screen.getByRole('switch', { name: 'Simple mode' }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.checked).toBe(false)
  })

  it('ignores a config read that settles after unmount, either way', async () => {
    let settle: (value: { simpleMode: boolean }) => void = () => {}
    let fail: (reason: Error) => void = () => {}
    ;(window as Window & { shell?: unknown }).shell = {
      getConfig: () => new Promise<{ simpleMode: boolean }>((resolve, reject) => {
        settle = resolve
        fail = reject
      }),
      saveConfig: async () => ({ simpleMode: true }),
    }
    const resolved = render(<SimpleModeRow {...props()} />)
    resolved.unmount()
    await act(async () => { settle({ simpleMode: true }) })

    const rejected = render(<SimpleModeRow {...props()} />)
    rejected.unmount()
    await act(async () => { fail(new Error('gone')) })
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
