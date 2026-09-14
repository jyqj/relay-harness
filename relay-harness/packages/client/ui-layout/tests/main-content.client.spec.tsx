// @vitest-environment jsdom
/** Main-page navigation through the real slot renderer and observable binding. */
import { useState } from 'react'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SlotTestRuntime } from '@relay-harness/rlh-client-test-runtime'
import { createSnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import { MainContent } from '../src/client/MainContent.tsx'
import { MainNavigation } from '../src/client/navigation.ts'

let runtime: SlotTestRuntime | undefined
afterEach(async () => { cleanup(); await runtime?.dispose(); runtime = undefined })
function ConversationDraft() {
  const [value, setValue] = useState('')
  return <input aria-label="Conversation draft" value={value} onChange={event => { setValue(event.target.value) }} />
}
function LibraryDraft() {
  const [value, setValue] = useState('')
  return <input aria-label="Library query" value={value} onChange={event => { setValue(event.target.value) }} />
}
async function bench() {
  runtime = await SlotTestRuntime.create()
  await runtime.declare({ 'shell.main': { kind: 'single', scope: 'root' } })
  const navigation = new MainNavigation()
  const pages = createSnapshotStore<readonly string[]>(['work', 'library'])
  runtime.slots.register({ name: 'shell.main', children: {
    conversation: { kind: 'single', scope: 'session-maybe' }, 'shell.page': { kind: 'keyed', scope: 'root' },
  }, inject: () => ({ hooks: { mainNavigation: navigation, mainPages: pages } }) }, MainContent)
  runtime.slots.register({ name: 'conversation' }, ConversationDraft)
  const offWork = runtime.slots.register({ name: 'shell.page', key: 'work' }, () => <h2>Current work</h2>)
  runtime.slots.register({ name: 'shell.page', key: 'library' }, LibraryDraft)
  const view = runtime.renderSlot('shell.main', {})
  return { navigation, pages, view, offWork }
}

describe('resident main pages', () => {
  it('keeps conversation and library drafts while changing the central page', async () => {
    const { navigation, view } = await bench()
    const conversation = screen.getByRole('textbox', { name: 'Conversation draft' })
    fireEvent.change(conversation, { target: { value: 'unsent instructions' } })
    act(() => { navigation.open('work') })
    expect(screen.getByRole('heading', { name: 'Current work' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Conversation draft' })).toBeNull()
    expect(view.container.querySelector('[aria-label="Conversation draft"]')).toBe(conversation)
    act(() => { navigation.open('library') })
    fireEvent.change(screen.getByRole('textbox', { name: 'Library query' }), { target: { value: 'unsent query' } })
    act(() => { navigation.open('conversation') })
    expect((screen.getByRole('textbox', { name: 'Conversation draft' }) as HTMLInputElement).value).toBe('unsent instructions')
    expect(screen.queryByRole('textbox', { name: 'Library query' })).toBeNull()
    act(() => { navigation.open('library') })
    expect((screen.getByRole('textbox', { name: 'Library query' }) as HTMLInputElement).value).toBe('unsent query')
    expect(document.activeElement?.getAttribute('data-main-page')).toBe('library')
  })

  it('falls back when a page disappears, releases its subtree, and keeps the conversation', async () => {
    const { navigation, pages, offWork, view } = await bench()
    act(() => { navigation.open('work') })
    expect(screen.getByRole('heading', { name: 'Current work' })).toBeTruthy()
    act(() => { offWork(); pages.set(['library']) })
    expect(screen.getByRole('textbox', { name: 'Conversation draft' })).toBeTruthy()
    await waitFor(() => { expect(view.container.querySelector('[data-main-page="work"]')).toBeNull() })
    act(() => { navigation.open('unknown-plugin') })
    expect(screen.getByRole('textbox', { name: 'Conversation draft' })).toBeTruthy()
  })

  it('publishes explicit navigation, including reselect, and never changes another owner', () => {
    const first = new MainNavigation()
    const second = new MainNavigation()
    const snapshots: string[] = []
    const off = first.subscribe(() => { snapshots.push(first.getSnapshot().page) })
    const original = first.getSnapshot()
    expect(first.getSnapshot()).toBe(original)
    first.open('work'); first.open('work')
    expect(snapshots).toEqual(['work', 'work'])
    expect(first.getSnapshot().revision).toBe(2)
    expect(second.getSnapshot()).toEqual({ page: 'conversation', revision: 0 })
    off(); first.open('library')
    expect(snapshots).toHaveLength(2)
  })
})
