import {
  useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent,
} from 'react'
import type { HistoryEntry, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  buildSessionTreeGraph, currentPathCuts, sessionIdsForAnchor, sessionOfCardId, visibleSessionTreeGraph,
  type SessionTreeCard,
} from './model.ts'
import type { SessionTreeOpenState } from './controller.ts'
import type { SessionTreeFilterMode, SessionTreeStore, SessionTreeViewport } from './store.ts'
import css from './SessionTreeCanvas.module.css'

/** Business callbacks hidden behind the Tree slot's inject face. */
export interface SessionTreeCanvasInjected {
  hooks: { treeOpen: SnapshotStore<SessionTreeOpenState> }
  closeTree: () => void
  loadHistory: (sessionId: SessionId, signal?: AbortSignal) => Promise<HistoryEntry[]>
  openSession: (sessionId: SessionId) => void
  forkSession: (input: { sessionId: SessionId; atSeq?: number; beforeSeq?: number }) => Promise<SessionId>
  sendMessage: (sessionId: SessionId, text: string) => Promise<void>
  startSession: (workspaceId?: WorkspaceId) => void
  archiveSession: (sessionId: SessionId) => Promise<void>
}

export type SessionTreeCanvasProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<SessionTreeStore>
  & PropsLocale<'sessionTree'>
  & InjectFace<SessionTreeCanvasInjected>

interface DragState {
  kind: 'card' | 'canvas'
  id?: string
  startClient: { x: number; y: number }
  startValue: { x: number; y: number }
}

function boundedZoom(value: number): number {
  return Math.min(4, Math.max(0.35, Math.round(value * 100) / 100))
}

/** Upper bound on concurrent per-Session history fetches while progressive loading drains its queue. */
const HISTORY_LOAD_CONCURRENCY = 4

function connector(from: SessionTreeCard, to: SessionTreeCard): string {
  const x1 = from.position.x + 300
  const y1 = from.position.y + 112
  const x2 = to.position.x
  const y2 = to.position.y + 112
  const bend = Math.max(48, Math.abs(x2 - x1) * 0.45)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

/** Native full-frame Session Tree canvas. */
export function SessionTreeCanvas({
  useTreeOpen, useSessions, useWorkspaces, useStore, actions, closeTree, loadHistory,
  openSession, forkSession, sendMessage, startSession, archiveSession, t,
}: SessionTreeCanvasProps) {
  const openState = useTreeOpen(value => value)
  const sessions = useSessions(value => value)
  const workspaces = useWorkspaces(value => value)
  const tree = useStore(value => value)
  const [histories, setHistories] = useState<Record<string, readonly HistoryEntry[]>>({})
  const [loadingCount, setLoadingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number } | null>(null)
  const [cameraPreview, setCameraPreview] = useState<SessionTreeViewport | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const loadHistoryRef = useRef(loadHistory)
  const closeTreeRef = useRef(closeTree)
  loadHistoryRef.current = loadHistory
  closeTreeRef.current = closeTree
  const historiesRef = useRef(histories)
  historiesRef.current = histories
  const anchorSessionId = openState.anchorSessionId ?? sessions.current
  const sessionIds = useMemo(() => anchorSessionId === undefined
    ? []
    : sessionIdsForAnchor(sessions, workspaces, anchorSessionId), [anchorSessionId, sessions, workspaces])
  const revision = sessionIds.map((id) => {
    const value = sessions.byId[id]
    return `${id}:${value?.updatedAt ?? 0}:${value?.running ? 1 : 0}:${value?.seedLength ?? ''}`
  }).join('|')

  // Progressive history loading: lineage (parentId, seedLength) travels in the
  // Session list metadata, so the graph renders complete structure from stub
  // cards and a Session's full history is fetched only once the operator
  // selects one of its cards. A revision change (appended events, a running
  // toggle) refreshes the already-loaded share without fetching anything new,
  // and closing the overlay aborts every in-flight read on the wire.
  const historyQueueRef = useRef<SessionId[]>([])
  const historyInflightRef = useRef<Set<SessionId>>(new Set())
  const historyActiveRef = useRef(0)
  const historyControllerRef = useRef<AbortController | null>(null)
  const pumpHistoryQueue = useCallback((): void => {
    for (;;) {
      const controller = historyControllerRef.current
      if (controller === null) return
      if (historyActiveRef.current >= HISTORY_LOAD_CONCURRENCY) return
      const next = historyQueueRef.current.shift()
      if (next === undefined) return
      historyActiveRef.current += 1
      setLoadingCount(historyActiveRef.current)
      loadHistoryRef.current(next, controller.signal).then(
        (entries) => {
          if (!controller.signal.aborted) setHistories(prev => ({ ...prev, [next]: entries }))
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
        },
      ).finally(() => {
        historyInflightRef.current.delete(next)
        historyActiveRef.current -= 1
        setLoadingCount(historyActiveRef.current)
        pumpHistoryQueue()
      })
    }
  }, [])
  const requestSessionHistory = useCallback((sessionId: SessionId): void => {
    if (sessionId in historiesRef.current || historyInflightRef.current.has(sessionId)) return
    historyInflightRef.current.add(sessionId)
    historyQueueRef.current.push(sessionId)
    pumpHistoryQueue()
  }, [pumpHistoryQueue])

  useEffect(() => {
    if (!openState.open) return
    const controller = new AbortController()
    historyControllerRef.current = controller
    const loaded = Object.keys(historiesRef.current).filter(id => sessionIds.includes(id as SessionId)) as SessionId[]
    historyQueueRef.current = loaded
    historyInflightRef.current = new Set(loaded)
    setError(null)
    pumpHistoryQueue()
    return () => { controller.abort() }
  }, [openState.open, revision])

  const completeGraph = useMemo(
    () => buildSessionTreeGraph(sessions, sessionIds, histories, tree.positions),
    [histories, sessionIds, sessions, tree.positions],
  )
  const graph = useMemo(() => visibleSessionTreeGraph(completeGraph, {
    collapsed: tree.collapsed,
    labels: tree.labels,
    filterMode: tree.filterMode,
    query: tree.query,
  }), [completeGraph, tree.collapsed, tree.filterMode, tree.labels, tree.query])
  // Prune keeps persisted presentation state for existing cards plus, while a
  // listed Session's history has not loaded yet, that Session's older turn-card
  // entries — loading it later must not lose saved positions, labels, and
  // collapse choices.
  const pruneIds = useMemo(() => {
    const ids = new Set(completeGraph.cards.map(card => card.id))
    const pending = new Set(sessionIds.filter(id => histories[id] === undefined))
    if (pending.size > 0) {
      for (const key of [
        ...Object.keys(tree.positions),
        ...Object.keys(tree.collapsed),
        ...Object.keys(tree.labels),
      ]) {
        const owner = sessionOfCardId(key)
        if (owner !== undefined && pending.has(owner)) ids.add(key)
      }
    }
    return [...ids]
  }, [completeGraph, histories, sessionIds, tree.collapsed, tree.labels, tree.positions])
  const validCardIds = pruneIds.join('\u0000')
  useEffect(() => {
    actions.prune(pruneIds)
  }, [validCardIds])
  const selected = completeGraph.cards.find(card => card.id === tree.selectedCardId) ?? null
  const pathCuts = useMemo(() => currentPathCuts(sessions), [sessions])
  const onCurrentPath = (card: SessionTreeCard): boolean => {
    const cut = pathCuts.get(card.sessionId)
    return cut !== undefined && (card.endSeq ?? card.startSeq) < cut
  }
  const camera = cameraPreview ?? tree.viewport
  const displayedCards = graph.cards.map(card => dragPreview?.id === card.id
    ? { ...card, position: { x: dragPreview.x, y: dragPreview.y } }
    : card)
  const cardById = new Map(displayedCards.map(card => [card.id, card]))
  const workspace = workspaces.items.find(item => sessionIds.some(id => item.sessionIds.includes(id)))

  useEffect(() => {
    if (!openState.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeTreeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [openState.open])

  if (!openState.open) return null

  const commitOperation = (operation: Promise<unknown>): void => {
    setError(null)
    void operation.catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const focusCurrent = (): void => {
    const current = sessions.current
    const card = [...completeGraph.cards].reverse().find(candidate => candidate.sessionId === current)
    const viewport = viewportRef.current
    if (card === undefined || viewport === null) return
    actions.setViewport({
      x: viewport.clientWidth / 2 - (card.position.x + 150) * tree.viewport.zoom,
      y: viewport.clientHeight / 2 - (card.position.y + 112) * tree.viewport.zoom,
      zoom: tree.viewport.zoom,
    })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    const dx = event.clientX - drag.startClient.x
    const dy = event.clientY - drag.startClient.y
    if (drag.kind === 'card' && drag.id !== undefined) {
      setDragPreview({ id: drag.id, x: drag.startValue.x + dx / camera.zoom, y: drag.startValue.y + dy / camera.zoom })
    } else {
      setCameraPreview({ ...camera, x: drag.startValue.x + dx, y: drag.startValue.y + dy })
    }
  }
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (dragPreview !== null) actions.setPosition(dragPreview.id, { x: dragPreview.x, y: dragPreview.y })
    if (cameraPreview !== null) actions.setViewport(cameraPreview)
    dragRef.current = null
    setDragPreview(null)
    setCameraPreview(null)
  }
  const beginCanvasPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      kind: 'canvas', startClient: { x: event.clientX, y: event.clientY },
      startValue: { x: camera.x, y: camera.y },
    }
  }
  const beginCardDrag = (event: ReactPointerEvent<HTMLButtonElement>, card: SessionTreeCard): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    const viewport = viewportRef.current
    if (viewport === null) return
    viewport.setPointerCapture(event.pointerId)
    dragRef.current = {
      kind: 'card', id: card.id, startClient: { x: event.clientX, y: event.clientY },
      startValue: card.position,
    }
  }
  const zoomAtCenter = (delta: number): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const zoom = boundedZoom(camera.zoom + delta)
    const worldX = (viewport.clientWidth / 2 - camera.x) / camera.zoom
    const worldY = (viewport.clientHeight / 2 - camera.y) / camera.zoom
    actions.setViewport({
      zoom,
      x: viewport.clientWidth / 2 - worldX * zoom,
      y: viewport.clientHeight / 2 - worldY * zoom,
    })
  }
  const branch = (card: SessionTreeCard, before = false): Promise<void> => (async () => {
    const child = await forkSession({
      sessionId: card.sessionId,
      ...(before ? { beforeSeq: card.startSeq } : { atSeq: card.endSeq ?? card.startSeq }),
    })
    if (before) {
      const text = draft.trim() || card.userText
      if (text !== '') await sendMessage(child, text)
    }
    openSession(child)
    setDraft('')
  })()
  const continueSession = (card: SessionTreeCard): Promise<void> => (async () => {
    const text = draft.trim()
    if (text === '') return
    await sendMessage(card.sessionId, text)
    openSession(card.sessionId)
    setDraft('')
  })()

  return (
    <section className={css.overlay} role="dialog" aria-modal="true" aria-label={t('title')} data-shell-modal-overlay>
      <header className={css.toolbar}>
        <strong>{t('title')}</strong>
        <input
          value={tree.query}
          onChange={(event) => { actions.setQuery(event.currentTarget.value) }}
          placeholder={t('search')}
          aria-label={t('search')}
        />
        <select
          value={tree.filterMode}
          onChange={(event) => { actions.setFilterMode(event.currentTarget.value as SessionTreeFilterMode) }}
          aria-label={t('filterAria')}
        >
          {(['default', 'no-tools', 'user-only', 'labeled-only', 'all'] as const).map(mode => (
            <option key={mode} value={mode}>{t(`filters.${mode}`)}</option>
          ))}
        </select>
        <button type="button" onClick={() => { startSession(workspace?.workspaceId) }}>{t('newSession')}</button>
        <button type="button" onClick={focusCurrent}>{t('focusCurrent')}</button>
        <button type="button" onClick={() => { actions.resetPositions() }}>{t('resetLayout')}</button>
        <button type="button" onClick={() => { zoomAtCenter(-0.15) }} aria-label={t('zoomOut')}>−</button>
        <span className={css.zoom}>{Math.round(camera.zoom * 100)}%</span>
        <button type="button" onClick={() => { zoomAtCenter(0.15) }} aria-label={t('zoomIn')}>+</button>
        <button type="button" className={css.primary} onClick={closeTree}>{t('conversation')}</button>
      </header>
      {error !== null && <div className={css.error} role="alert">{error}<button type="button" onClick={() => { setError(null) }}>×</button></div>}
      {loadingCount > 0 && <div className={css.loading}>{t('loading')}</div>}
      <div
        ref={viewportRef}
        className={css.viewport}
        onPointerDown={beginCanvasPan}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          zoomAtCenter(event.deltaY > 0 ? -0.1 : 0.1)
        }}
      >
        {displayedCards.length === 0 && loadingCount === 0 && <div className={css.empty}>{t('empty')}</div>}
        <div className={css.world} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
          <svg className={css.connectors} aria-hidden="true">
            {graph.edges.map((edge) => {
              const from = cardById.get(edge.from)
              const to = cardById.get(edge.to)
              if (from === undefined || to === undefined) return null
              const edgeOnCurrentPath = onCurrentPath(from) && onCurrentPath(to)
              return (
                <path
                  key={`${edge.from}:${edge.to}`}
                  d={connector(from, to)}
                  data-branch={edge.branch || undefined}
                  data-current-path={edgeOnCurrentPath || undefined}
                />
              )
            })}
          </svg>
          {displayedCards.map((card) => {
            const label = tree.labels[card.id] ?? ''
            const selectedCard = tree.selectedCardId === card.id
            const current = sessions.current === card.sessionId
            const descendants = graph.descendantCounts[card.id] ?? 0
            return (
              <article
                key={card.id}
                className={css.card}
                data-selected={selectedCard || undefined}
                data-current={current || undefined}
                data-current-path={onCurrentPath(card) || undefined}
                style={{ left: card.position.x, top: card.position.y }}
                onClick={() => { actions.selectCard(card.id); requestSessionHistory(card.sessionId) }}
              >
                <button className={css.dragHandle} type="button" onPointerDown={(event) => { beginCardDrag(event, card) }} aria-label={t('moveCard')}>•••</button>
                <div className={css.cardHead}>
                  <span className={css.dot} />
                  <button type="button" className={css.sessionTitle} onClick={() => { openSession(card.sessionId) }}>{card.sessionTitle}</button>
                  {card.running && <span className={css.running}>{t('running')}</span>}
                </div>
                {label !== '' && <div className={css.label}>{label}</div>}
                <div className={css.question}>{card.userText || (card.blank ? t('blank') : `${t('turn')} ${card.turn ?? '—'}`)}</div>
                {tree.filterMode !== 'user-only' && card.assistantText !== '' && <div className={css.answer}>{card.assistantText}</div>}
                {tree.filterMode === 'all' && card.contextText !== '' && <div className={css.context}>{card.contextText}</div>}
                {tree.filterMode !== 'no-tools' && tree.filterMode !== 'user-only' && card.tools.length > 0 && (
                  <details className={css.tools} open={tree.filterMode === 'all'}>
                    <summary>{t('tools')} · {card.tools.length}</summary>
                    {card.tools.map(tool => (
                      <div key={tool.callId} data-error={tool.isError || undefined}>
                        <strong>{tool.name}</strong>{tool.resultText === '' ? null : ` · ${tool.resultText}`}
                      </div>
                    ))}
                  </details>
                )}
                <footer>
                  <button type="button" onClick={() => { openSession(card.sessionId) }}>{t('openSession')}</button>
                  <button type="button" onClick={() => { commitOperation(branch(card)) }}>{t('fork')}</button>
                  {descendants > 0 && (
                    <button type="button" onClick={() => { actions.toggleCollapsed(card.id) }}>
                      {tree.collapsed[card.id] ? `${t('expand')} ${descendants}` : `${t('collapse')} ${descendants}`}
                    </button>
                  )}
                </footer>
              </article>
            )
          })}
        </div>
      </div>
      {selected !== null && (
        <aside className={css.inspector}>
          <div className={css.inspectorHead}><strong>{selected.sessionTitle}</strong><button type="button" onClick={() => { actions.selectCard(null) }}>×</button></div>
          <label>{t('label')}<input value={tree.labels[selected.id] ?? ''} onChange={(event) => { actions.setLabel(selected.id, event.currentTarget.value) }} /></label>
          <div className={css.cut}>{t('branchAt')}: seq {selected.endSeq ?? selected.startSeq}</div>
          <textarea value={draft} onChange={(event) => { setDraft(event.currentTarget.value) }} placeholder={t('messageDraft')} />
          <div className={css.inspectorActions}>
            <button type="button" onClick={() => { commitOperation(branch(selected)) }}>{t('fork')}</button>
            {selected.userText !== '' && <button type="button" onClick={() => { commitOperation(branch(selected, true)) }}>{t('rewrite')}</button>}
            <button type="button" className={css.primary} disabled={draft.trim() === ''} onClick={() => { commitOperation(continueSession(selected)) }}>{t('send')}</button>
            <button type="button" className={css.danger} onClick={() => { commitOperation(archiveSession(selected.sessionId).then(() => { actions.selectCard(null) })) }}>{t('archive')}</button>
          </div>
        </aside>
      )}
    </section>
  )
}
