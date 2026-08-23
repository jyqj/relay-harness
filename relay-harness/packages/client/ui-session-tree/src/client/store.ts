import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Pi-inspired projection modes. Tool records remain folded into their Turn. */
export type SessionTreeFilterMode = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all'

/** Canvas camera persisted independently from Session facts. */
export interface SessionTreeViewport {
  x: number
  y: number
  zoom: number
}

/** Persisted presentation state. No message, title, or lineage data lives here. */
export interface SessionTreeState {
  viewport: SessionTreeViewport
  positions: Record<string, { x: number; y: number }>
  collapsed: Record<string, true>
  labels: Record<string, string>
  filterMode: SessionTreeFilterMode
  query: string
  selectedCardId: string | null
}

type SessionTreeActions = {
  setViewport: (draft: SessionTreeState, viewport: SessionTreeViewport) => void
  setPosition: (draft: SessionTreeState, cardId: string, position: { x: number; y: number }) => void
  resetPositions: (draft: SessionTreeState) => void
  toggleCollapsed: (draft: SessionTreeState, cardId: string) => void
  setLabel: (draft: SessionTreeState, cardId: string, label: string) => void
  setFilterMode: (draft: SessionTreeState, mode: SessionTreeFilterMode) => void
  setQuery: (draft: SessionTreeState, query: string) => void
  selectCard: (draft: SessionTreeState, cardId: string | null) => void
  prune: (draft: SessionTreeState, validCardIds: readonly string[]) => void
}

/**
 * Create the root-scoped persisted Tree presentation store.
 * @returns a store handle instantiated by the slot renderer.
 */
export function createSessionTreeStore(): EngineStoreHandle<SessionTreeState, SessionTreeActions> {
  return defineStore({
    init: (): SessionTreeState => ({
      viewport: { x: 48, y: 56, zoom: 1 },
      positions: {},
      collapsed: {},
      labels: {},
      filterMode: 'default',
      query: '',
      selectedCardId: null,
    }),
    persist: 'dsh.session-tree.layout.v1',
    actions: {
      setViewport: (draft, viewport) => { draft.viewport = viewport },
      setPosition: (draft, cardId, position) => { draft.positions[cardId] = position },
      resetPositions: (draft) => { draft.positions = {} },
      toggleCollapsed: (draft, cardId) => {
        if (draft.collapsed[cardId]) {
          draft.collapsed = Object.fromEntries(
            Object.entries(draft.collapsed).filter(([id]) => id !== cardId),
          )
        } else {
          draft.collapsed[cardId] = true
        }
      },
      setLabel: (draft, cardId, label) => {
        const normalized = label.trim().slice(0, 80)
        if (normalized === '') {
          draft.labels = Object.fromEntries(
            Object.entries(draft.labels).filter(([id]) => id !== cardId),
          )
        } else {
          draft.labels[cardId] = normalized
        }
      },
      setFilterMode: (draft, mode) => { draft.filterMode = mode },
      setQuery: (draft, query) => { draft.query = query.slice(0, 240) },
      selectCard: (draft, cardId) => { draft.selectedCardId = cardId },
      prune: (draft, validCardIds) => {
        const valid = new Set(validCardIds)
        const retain = <T>(record: Record<string, T>): Record<string, T> =>
          Object.fromEntries(Object.entries(record).filter(([id]) => valid.has(id)))
        const positions = retain(draft.positions)
        const collapsed = retain(draft.collapsed)
        const labels = retain(draft.labels)
        if (Object.keys(positions).length !== Object.keys(draft.positions).length) draft.positions = positions
        if (Object.keys(collapsed).length !== Object.keys(draft.collapsed).length) draft.collapsed = collapsed
        if (Object.keys(labels).length !== Object.keys(draft.labels).length) draft.labels = labels
        if (draft.selectedCardId !== null && !valid.has(draft.selectedCardId)) draft.selectedCardId = null
      },
    },
  })
}

/** Store type consumed by slot prop derivation. */
export type SessionTreeStore = ReturnType<typeof createSessionTreeStore>
