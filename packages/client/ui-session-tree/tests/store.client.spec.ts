// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createSessionTreeStore } from '../src/client/store.ts'

beforeEach(() => { localStorage.clear() })

describe('Session Tree store', () => {
  it('persists camera and card layout while reset removes every manual position', () => {
    const store = createSessionTreeStore().create()
    store.actions.setViewport({ x: 1, y: 2, zoom: 1.5 })
    store.actions.setPosition('a', { x: 3, y: 4 })
    expect(store.getSnapshot()).toMatchObject({ viewport: { x: 1, y: 2, zoom: 1.5 }, positions: { a: { x: 3, y: 4 } } })
    store.actions.resetPositions()
    expect(store.getSnapshot().positions).toEqual({})
  })

  it('toggles collapse and normalizes label add/remove', () => {
    const store = createSessionTreeStore().create()
    store.actions.toggleCollapsed('a')
    expect(store.getSnapshot().collapsed).toEqual({ a: true })
    store.actions.toggleCollapsed('a')
    expect(store.getSnapshot().collapsed).toEqual({})
    store.actions.setLabel('a', `  ${'x'.repeat(100)}  `)
    expect(store.getSnapshot().labels.a).toBe('x'.repeat(80))
    store.actions.setLabel('a', '  ')
    expect(store.getSnapshot().labels).toEqual({})
  })

  it('writes filter, bounded query, and selection through declared actions', () => {
    const store = createSessionTreeStore().create()
    store.actions.setFilterMode('all')
    store.actions.setQuery('q'.repeat(300))
    store.actions.selectCard('card')
    expect(store.getSnapshot()).toMatchObject({ filterMode: 'all', query: 'q'.repeat(240), selectedCardId: 'card' })
    store.actions.selectCard(null)
    expect(store.getSnapshot().selectedCardId).toBeNull()
  })

  it('prunes layout and selection that no longer belong to the business graph', () => {
    const store = createSessionTreeStore().create()
    store.actions.setPosition('keep', { x: 1, y: 2 })
    store.actions.setPosition('drop', { x: 3, y: 4 })
    store.actions.toggleCollapsed('drop')
    store.actions.setLabel('drop', 'old')
    store.actions.selectCard('drop')
    store.actions.prune(['keep'])
    expect(store.getSnapshot()).toMatchObject({
      positions: { keep: { x: 1, y: 2 } }, collapsed: {}, labels: {}, selectedCardId: null,
    })
    const before = store.getSnapshot()
    store.actions.prune(['keep'])
    expect(store.getSnapshot()).toEqual(before)
  })
})
