import type { HistoryEntry, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  SessionListState, SessionSummary, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionTreeFilterMode } from './store.ts'

const CARD_X_GAP = 350
const CARD_Y_GAP = 286

/** One tool call/result pair folded into its assistant Turn card. */
export interface SessionTreeToolProcess {
  callId: string
  name: string
  resultText: string
  isError: boolean
}

/** One Turn card in the workspace conversation graph. */
export interface SessionTreeCard {
  id: string
  sessionId: SessionId
  sessionTitle: string
  parentId?: string
  turn?: number
  startSeq: number
  endSeq?: number
  userText: string
  contextText: string
  assistantText: string
  tools: readonly SessionTreeToolProcess[]
  running: boolean
  blank: boolean
  position: { x: number; y: number }
}

/** One directed visible connector. */
export interface SessionTreeEdge {
  from: string
  to: string
  branch: boolean
}

/** Complete unfiltered graph plus descendant counts used by collapse controls. */
export interface SessionTreeGraph {
  cards: readonly SessionTreeCard[]
  edges: readonly SessionTreeEdge[]
  descendantCounts: Readonly<Record<string, number>>
}

interface MutableTurn {
  turn: number
  startSeq: number
  endSeq?: number
  userText: string[]
  contextText: string[]
  assistantText: string[]
  tools: SessionTreeToolProcess[]
}

/**
 * Flatten model-facing text blocks without exposing image bytes or tool JSON.
 * @param content - merge-extensible message content.
 * @returns visible text with image placeholders.
 */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  const visit = (block: unknown): void => {
    if (typeof block !== 'object' || block === null) return
    const value = block as Record<string, unknown>
    if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string') {
      out.push(value.text)
    } else if (value.type === 'image') {
      out.push('[图片]')
    } else if (value.type === 'tool-result' && Array.isArray(value.content)) {
      for (const child of value.content) visit(child)
    }
  }
  for (const block of content) visit(block)
  return out.join('\n').trim()
}

/**
 * Project only this Session's own live tail; a fork's inherited prefix belongs to its parent lane.
 * @param summary - Session identity, lineage, and live state.
 * @param history - complete durable history.
 * @returns ordered Turn projections owned by this Session.
 */
export function projectSessionTurns(summary: SessionSummary, history: readonly HistoryEntry[]): MutableTurn[] {
  const inherited = summary.parentId === undefined ? 0 : (summary.seedLength ?? 0)
  const turns = new Map<number, MutableTurn>()
  let currentTurn: number | undefined
  const ensure = (turn: number, startSeq: number): MutableTurn => {
    const existing = turns.get(turn)
    if (existing !== undefined) return existing
    const created: MutableTurn = {
      turn, startSeq, userText: [], contextText: [], assistantText: [], tools: [],
    }
    turns.set(turn, created)
    return created
  }
  for (const { event } of history) {
    if (event.seq < inherited) continue
    switch (event.type) {
      case 'turn/start': {
        currentTurn = event.data.turn
        ensure(event.data.turn, event.seq)
        break
      }
      case 'turn/end': {
        ensure(event.data.turn, event.seq).endSeq = event.seq
        if (currentTurn === event.data.turn) currentTurn = undefined
        break
      }
      case 'user/message': {
        if (currentTurn === undefined) break
        const text = messageText(event.data.content)
        if (text === '') break
        const turn = ensure(currentTurn, event.seq)
        if (event.data.source.kind === 'user') turn.userText.push(text)
        else turn.contextText.push(text)
        break
      }
      case 'assistant/message': {
        const text = messageText(event.data.message.content)
        if (text !== '') ensure(event.data.turn, event.seq).assistantText.push(text)
        break
      }
      case 'tool/call': {
        ensure(event.data.turn, event.seq).tools.push({
          callId: event.data.callId,
          name: event.data.name,
          resultText: '',
          isError: false,
        })
        break
      }
      case 'tool/result': {
        const turn = ensure(event.data.turn, event.seq)
        const callId = event.data.message.source.callId
        const existing = turn.tools.find(tool => tool.callId === callId)
        const resultText = messageText(event.data.message.content)
        if (existing === undefined) {
          turn.tools.push({
            callId,
            name: 'tool',
            resultText,
            isError: event.data.error !== undefined,
          })
        } else {
          existing.resultText = resultText
          existing.isError = event.data.error !== undefined
        }
        break
      }
      default:
        break
    }
  }
  return [...turns.values()].sort((a, b) => a.startSeq - b.startSeq)
}

/**
 * Resolve the workspace family around an anchor while retaining hidden subagent descendants.
 * @param sessions - global Session list snapshot.
 * @param workspaces - Workspace registry and archive snapshot.
 * @param anchorSessionId - Session used to select a workspace or cwd family.
 * @returns ordered visible Session ids.
 */
export function sessionIdsForAnchor(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  anchorSessionId: SessionId,
): SessionId[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const parentOf = (id: SessionId): SessionId | undefined => sessions.byId[id]?.parentId
  const ancestry = new Set<SessionId>()
  let cursor: SessionId | undefined = anchorSessionId
  while (cursor !== undefined && !ancestry.has(cursor)) {
    ancestry.add(cursor)
    cursor = parentOf(cursor)
  }
  const workspace = workspaces.items.find(item => item.sessionIds.some(id => ancestry.has(id)))
  const selected = new Set<SessionId>(workspace?.sessionIds ?? [])
  if (selected.size === 0) {
    const cwd = sessions.byId[anchorSessionId]?.cwd
    for (const id of sessions.ids) {
      if (cwd !== undefined && sessions.byId[id]?.cwd === cwd) selected.add(id)
    }
  }
  for (const id of ancestry) selected.add(id)
  let changed = true
  while (changed) {
    changed = false
    for (const id of sessions.ids) {
      const parent = parentOf(id)
      if (parent !== undefined && selected.has(parent) && !selected.has(id)) {
        selected.add(id)
        changed = true
      }
    }
  }
  return sessions.ids.filter(id => selected.has(id) && !archived.has(id))
}

/**
 * Resolve the exact current lineage path as an exclusive event cut per Session.
 * @param sessions - global Session list snapshot with current selection.
 * @returns Session cuts; `Infinity` marks the complete current lane.
 */
export function currentPathCuts(sessions: SessionListState): ReadonlyMap<SessionId, number> {
  const cuts = new Map<SessionId, number>()
  let childId: SessionId | undefined = sessions.current
  if (childId === undefined) return cuts
  cuts.set(childId, Number.POSITIVE_INFINITY)
  for (;;) {
    const child = Object.entries(sessions.byId).find(([id]) => id === childId)?.[1]
    if (child === undefined) break
    const parentId = child.parentId
    if (parentId === undefined || cuts.has(parentId)) break
    cuts.set(parentId, child.seedLength ?? Number.POSITIVE_INFINITY)
    childId = parentId
  }
  return cuts
}

function normalizedParents(summaries: readonly SessionSummary[]): Map<SessionId, SessionId | undefined> {
  const ids = new Set(summaries.map(summary => summary.id))
  const raw = new Map(summaries.map(summary => [summary.id, summary.parentId]))
  const out = new Map<SessionId, SessionId | undefined>()
  for (const summary of summaries) {
    const seen = new Set<SessionId>([summary.id])
    let parent = raw.get(summary.id)
    let valid = parent !== undefined && ids.has(parent)
    while (valid && parent !== undefined) {
      if (seen.has(parent)) {
        valid = false
        break
      }
      seen.add(parent)
      parent = raw.get(parent)
      valid = parent === undefined || ids.has(parent)
    }
    const direct = raw.get(summary.id)
    out.set(summary.id, valid && direct !== undefined && ids.has(direct) ? direct : undefined)
  }
  return out
}

/**
 * The Session a card id belongs to, so persisted presentation state can be
 * retained across progressive history loads.
 * @param cardId - card id as built by `buildSessionTreeGraph`.
 * @returns the owning Session id, or undefined for foreign keys.
 */
export function sessionOfCardId(cardId: string): SessionId | undefined {
  if (cardId.startsWith('session:')) return cardId.slice('session:'.length) as SessionId
  if (cardId.startsWith('turn:')) {
    // startSeq is the suffix after the final separator; a Session id may itself contain colons.
    const cut = cardId.lastIndexOf(':')
    return cut === 'turn:'.length - 1 ? undefined : cardId.slice('turn:'.length, cut) as SessionId
  }
  return undefined
}

/**
 * Build the complete conversation graph before query/filter/collapse projection.
 * Sessions whose history has not loaded yet contribute one stub card anchored at
 * their inherited prefix, so the lineage structure is complete from list metadata alone.
 * @param sessions - global Session list snapshot.
 * @param sessionIds - selected workspace family in display order.
 * @param histories - complete history keyed by Session id; missing entries degrade to a stub card.
 * @param positions - persisted card-position overrides.
 * @returns complete card and connector graph.
 */
export function buildSessionTreeGraph(
  sessions: SessionListState,
  sessionIds: readonly SessionId[],
  histories: Readonly<Record<string, readonly HistoryEntry[]>>,
  positions: Readonly<Record<string, { x: number; y: number }>> = {},
): SessionTreeGraph {
  const summaries = sessionIds.map(id => sessions.byId[id]).filter((value): value is SessionSummary => value !== undefined)
  const summaryById = new Map(summaries.map(summary => [summary.id, summary]))
  const parentById = normalizedParents(summaries)
  const children = new Map<SessionId, SessionId[]>()
  const roots: SessionId[] = []
  for (const summary of summaries) {
    const parent = parentById.get(summary.id)
    if (parent === undefined) roots.push(summary.id)
    else children.set(parent, [...(children.get(parent) ?? []), summary.id])
  }

  const cards: SessionTreeCard[] = []
  const edges: SessionTreeEdge[] = []
  const lastCardBySession = new Map<SessionId, SessionTreeCard>()
  let lane = 0
  const visited = new Set<SessionId>()
  const visit = (sessionId: SessionId, parentAnchor?: SessionTreeCard): void => {
    if (visited.has(sessionId)) return
    visited.add(sessionId)
    const summary = summaryById.get(sessionId)
    /* v8 ignore next -- visit receives only ids collected from summary rows. */
    if (summary === undefined) return
    const ownLane = lane++
    const turns = projectSessionTurns(summary, histories[sessionId] ?? [])
    const descriptors = turns.length === 0
      ? [{
        turn: undefined, startSeq: summary.seedLength ?? 0, endSeq: undefined,
        userText: [], contextText: [], assistantText: [], tools: [],
      }]
      : turns
    const startX = parentAnchor === undefined ? 80 : parentAnchor.position.x + CARD_X_GAP
    let previous = parentAnchor
    for (const [index, turn] of descriptors.entries()) {
      const id = index === 0 ? `session:${sessionId}` : `turn:${sessionId}:${turn.startSeq}`
      const automatic = { x: startX + index * CARD_X_GAP, y: 80 + ownLane * CARD_Y_GAP }
      const card: SessionTreeCard = {
        id,
        sessionId,
        sessionTitle: summary.displayTitle,
        ...(previous === undefined ? {} : { parentId: previous.id }),
        ...(turn.turn === undefined ? {} : { turn: turn.turn }),
        startSeq: turn.startSeq,
        ...(turn.endSeq === undefined ? {} : { endSeq: turn.endSeq }),
        userText: turn.userText.join('\n'),
        contextText: turn.contextText.join('\n'),
        assistantText: turn.assistantText.join('\n'),
        tools: turn.tools,
        running: summary.running && index === descriptors.length - 1,
        blank: summary.blank,
        position: positions[id] ?? automatic,
      }
      cards.push(card)
      if (previous !== undefined) {
        edges.push({ from: previous.id, to: card.id, branch: previous.sessionId !== card.sessionId })
      }
      previous = card
    }
    const last = previous
    /* v8 ignore next -- descriptors always contains a Turn or the one Session stub. */
    if (last !== undefined) lastCardBySession.set(sessionId, last)
    for (const childId of children.get(sessionId) ?? []) {
      const child = summaryById.get(childId)
      const parentCards = cards.filter(card => card.sessionId === sessionId)
      const cut = child?.seedLength
      const anchor = cut === undefined
        ? lastCardBySession.get(sessionId)
        : [...parentCards].reverse().find(card => (card.endSeq ?? card.startSeq) < cut)
          ?? parentCards[0]
      visit(childId, anchor)
    }
  }
  for (const root of roots) visit(root)
  for (const summary of summaries) visit(summary.id)

  const directChildren = new Map<string, string[]>()
  for (const edge of edges) directChildren.set(edge.from, [...(directChildren.get(edge.from) ?? []), edge.to])
  const descendantCounts: Record<string, number> = {}
  for (const card of cards) {
    const seen = new Set<string>()
    const pending = [...(directChildren.get(card.id) ?? [])]
    while (pending.length > 0) {
      const id = pending.pop()
      /* v8 ignore next -- a non-empty string array cannot pop undefined; graph construction has one parent per card. */
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      pending.push(...(directChildren.get(id) ?? []))
    }
    descendantCounts[card.id] = seen.size
  }
  return { cards, edges, descendantCounts }
}

/**
 * Apply collapse, labels and text query while retaining the ancestor path of every visible match.
 * @param graph - complete workspace graph.
 * @param options - presentation filters and persisted labels/collapse choices.
 * @returns visible graph with navigable ancestor connectors.
 */
export function visibleSessionTreeGraph(
  graph: SessionTreeGraph,
  options: {
    collapsed: Readonly<Record<string, true>>
    labels: Readonly<Record<string, string>>
    filterMode: SessionTreeFilterMode
    query: string
  },
): SessionTreeGraph {
  const parent = new Map(graph.edges.map(edge => [edge.to, edge.from]))
  const children = new Map<string, string[]>()
  for (const edge of graph.edges) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to])
  const hidden = new Set<string>()
  for (const id of Object.keys(options.collapsed)) {
    const pending = [...(children.get(id) ?? [])]
    while (pending.length > 0) {
      const child = pending.pop()
      /* v8 ignore next -- a non-empty string array cannot pop undefined. */
      if (child === undefined || hidden.has(child)) continue
      hidden.add(child)
      pending.push(...(children.get(child) ?? []))
    }
  }
  const query = options.query.trim().toLocaleLowerCase()
  const matches = new Set<string>()
  for (const card of graph.cards) {
    if (hidden.has(card.id)) continue
    const labeled = (options.labels[card.id] ?? '') !== ''
    const toolText = card.tools.flatMap(tool => [tool.name, tool.resultText])
    const text = [card.sessionTitle, card.userText, card.assistantText, card.contextText, ...toolText, options.labels[card.id] ?? '']
      .join('\n').toLocaleLowerCase()
    const matchesMode = options.filterMode === 'labeled-only'
      ? labeled
      : options.filterMode !== 'user-only' || card.userText !== ''
    if (matchesMode && (query === '' || text.includes(query))) {
      matches.add(card.id)
    }
  }
  const visible = new Set(matches)
  if (query !== '' || options.filterMode === 'labeled-only' || options.filterMode === 'user-only') {
    for (const id of matches) {
      let cursor = parent.get(id)
      while (cursor !== undefined && !visible.has(cursor)) {
        visible.add(cursor)
        cursor = parent.get(cursor)
      }
    }
  }
  const cards = graph.cards.filter(card => visible.has(card.id))
  const visibleIds = new Set(cards.map(card => card.id))
  const edges: SessionTreeEdge[] = []
  for (const card of cards) {
    const ancestor = parent.get(card.id)
    if (ancestor !== undefined && visibleIds.has(ancestor)) {
      const source = graph.cards.find(candidate => candidate.id === ancestor)
      edges.push({ from: ancestor, to: card.id, branch: source?.sessionId !== card.sessionId })
    }
  }
  return { cards, edges, descendantCounts: graph.descendantCounts }
}
