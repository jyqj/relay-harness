// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'
import { SessionTreeTitlebarAction, type SessionTreeTitlebarActionProps } from '../src/client/SessionTreeTitlebarAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const neverHook = (() => { throw new Error('unused hook') }) as never
const t: SessionTreeTitlebarActionProps['t'] = key => (en as Record<string, string>)[key] ?? key
const sessions = (current?: SessionId): SessionTreeTitlebarActionProps['useSessions'] => selector => selector({
  ids: current === undefined ? [] : [current],
  byId: {},
  current,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
})

describe('SessionTreeTitlebarAction', () => {
  it('disables without a current Session and opens around the current id when available', () => {
    const openTree = vi.fn()
    const { rerender } = render(
      <SessionTreeTitlebarAction
        surfaces={0} terminalDrawer={0} useSessions={sessions()} useWorkspaces={neverHook} openTree={openTree} t={t}
      />,
    )
    const disabled = screen.getByRole<HTMLButtonElement>('button', { name: 'Open Session Tree' })
    expect(disabled.disabled).toBe(true)
    rerender(
      <SessionTreeTitlebarAction
        surfaces={0} terminalDrawer={0} useSessions={sessions('current' as SessionId)}
        useWorkspaces={neverHook} openTree={openTree} t={t}
      />,
    )
    const enabled = screen.getByRole<HTMLButtonElement>('button', { name: 'Open Session Tree' })
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)
    expect(openTree).toHaveBeenCalledWith('current')
  })
})
