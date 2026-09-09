/** View-local variable-height virtualization, with explicit full-history and interaction retention. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from '@tanstack/react-virtual'
import type { ChatScrollPosition } from '../contract/slots.ts'

const ESTIMATED_ROW_HEIGHT = 96
const INITIAL_VIEWPORT_HEIGHT = 600
const OVERSCAN_ROWS = 12
const VIRTUAL_THRESHOLD = 80

/** Read only explicit interaction state from mounted row DOM; no business state is owned here. */
function retainedKeys(root: HTMLElement): string[] {
  const keys = new Set<string>()
  const add = (node: Node | null): void => {
    const element = node instanceof Element ? node : node?.parentElement
    const row = element?.closest<HTMLElement>('[data-chat-flow-key]')
    if (row !== undefined && row !== null && root.contains(row) && row.dataset.chatFlowKey !== undefined) keys.add(row.dataset.chatFlowKey)
  }
  add(document.activeElement)
  for (const expanded of root.querySelectorAll('[aria-expanded="true"]')) add(expanded)
  const selection = document.getSelection()
  if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    for (const row of root.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
      if (range.intersectsNode(row)) add(row)
    }
  }
  return [...keys]
}

interface ChatWindow {
  readonly enabled: boolean
  readonly fullHistory: boolean
  readonly setFullHistory: (value: boolean) => void
  readonly rowsRef: RefObject<HTMLDivElement>
  readonly virtualizer: Virtualizer<HTMLElement, HTMLDivElement>
  readonly scrollMargin: number
  readonly pinnedCount: number
  readonly items: readonly { key: string; index: number; top: number | undefined }[]
}

/**
 * Keep a bounded viewport while preserving selected/focused/expanded rows and a remount anchor.
 * @param keys - stable ordered conversation node identities.
 * @param sessionId - resets view-local interaction state when retargeted.
 * @param listRef - existing conversation scroll host resolver.
 * @param readPosition - per-session semantic scroll memory.
 * @returns virtual items, measurement seat, explicit mode actions, and retained-interaction count.
 */
export function useChatWindow(
  keys: readonly string[],
  sessionId: string,
  listRef: RefObject<HTMLElement>,
  readPosition: () => ChatScrollPosition | null,
): ChatWindow {
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const [fullHistory, setFullHistory] = useState(false)
  const [pins, setPins] = useState<readonly string[]>([])
  const [scrollMargin, setScrollMargin] = useState(0)
  const saved = readPosition()
  const [restoreKey, setRestoreKey] = useState(() => saved?.nodeKey ?? saved?.anchorKey)
  const owner = useRef(sessionId)
  if (owner.current !== sessionId) {
    owner.current = sessionId
    setFullHistory(false)
    setPins([])
    setRestoreKey(saved?.nodeKey ?? saved?.anchorKey)
  }
  const index = useMemo(() => new Map(keys.map((key, position) => [key, position])), [keys])
  const enabled = keys.length > VIRTUAL_THRESHOLD && !fullHistory
  const mode = useRef(enabled)
  if (mode.current !== enabled) {
    mode.current = enabled
    if (enabled) setRestoreKey(saved?.nodeKey ?? saved?.anchorKey)
  }
  const getScrollElement = useCallback(() => {
    const local = listRef.current
    return local?.closest<HTMLElement>('[data-conversation-scroll]') ?? local
  }, [listRef])
  const readerKey = saved?.nodeKey ?? saved?.anchorKey
  const rangeExtractor = useCallback((range: Range) => {
    const included = new Set(defaultRangeExtractor(range))
    for (const key of [...pins, restoreKey, readerKey]) {
      if (key === undefined) continue
      const position = index.get(key)
      if (position !== undefined) included.add(position)
    }
    return [...included].sort((left, right) => left - right)
  }, [index, pins, restoreKey, readerKey])
  const getItemKey = useCallback((position: number) => `${sessionId}:${keys[position] ?? position}`, [sessionId, keys])
  const estimateSize = useCallback(() => ESTIMATED_ROW_HEIGHT, [])
  const measureElement = useCallback((element: HTMLDivElement) => element.getBoundingClientRect().height || ESTIMATED_ROW_HEIGHT, [])
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: enabled ? keys.length : 0,
    enabled,
    getScrollElement,
    getItemKey,
    estimateSize,
    measureElement,
    initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT },
    initialOffset: () => saved?.scrollTop ?? Math.max(0, keys.length * (ESTIMATED_ROW_HEIGHT + 16) - INITIAL_VIEWPORT_HEIGHT),
    // ChatView owns semantic anchoring and follow state. The virtualizer
    // must not independently move the shared scrollport during prepend.
    anchorTo: 'start',
    overscan: OVERSCAN_ROWS,
    gap: 16,
    scrollMargin,
    rangeExtractor,
  })
  // Measurement changes invalidate geometry, but only the conversation
  // scroll owner may compensate them (including async ResizeObserver work).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  const measuredSession = useRef(sessionId)
  useLayoutEffect(() => {
    if (measuredSession.current === sessionId) return
    measuredSession.current = sessionId
    virtualizer.measure()
    for (const row of rowsRef.current?.querySelectorAll<HTMLDivElement>('[data-chat-flow-key][data-index]') ?? []) virtualizer.measureElement(row)
  }, [sessionId, virtualizer])
  useLayoutEffect(() => {
    const rows = rowsRef.current
    const scroll = getScrollElement()
    if (!enabled || rows === null || scroll === null) return
    const top = rows.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    if (Math.abs(top - scrollMargin) > 0.5) setScrollMargin(top)
  })
  useEffect(() => { setRestoreKey(undefined) }, [sessionId, enabled])
  useEffect(() => {
    const root = rowsRef.current
    if (root === null) return
    const collect = (): void => {
      const next = retainedKeys(root)
      setPins(previous => previous.length === next.length && previous.every((key, i) => key === next[i]) ? previous : next)
    }
    const observer = new MutationObserver(collect)
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    collect()
    document.addEventListener('selectionchange', collect)
    root.addEventListener('focusin', collect)
    root.addEventListener('focusout', collect)
    return () => {
      observer.disconnect()
      document.removeEventListener('selectionchange', collect)
      root.removeEventListener('focusin', collect)
      root.removeEventListener('focusout', collect)
    }
  }, [sessionId, fullHistory])
  const setFull = (value: boolean): void => {
    const position = readPosition()
    setRestoreKey(position?.nodeKey ?? position?.anchorKey)
    setFullHistory(value)
  }
  const fullAction = useRef(setFull)
  fullAction.current = setFull
  useEffect(() => {
    const find = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') fullAction.current(true)
    }
    document.addEventListener('keydown', find)
    return () => { document.removeEventListener('keydown', find) }
  }, [])
  const virtualItems = enabled ? virtualizer.getVirtualItems() : []
  return {
    enabled, fullHistory, setFullHistory: setFull, rowsRef, virtualizer, scrollMargin,
    pinnedCount: pins.length,
    items: enabled
      ? virtualItems.map(item => ({ key: keys[item.index] as string, index: item.index, top: item.start - scrollMargin }))
      : keys.map((key, position) => ({ key, index: position, top: undefined })),
  }
}
