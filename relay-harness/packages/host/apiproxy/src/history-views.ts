/**
 * History projection: presenter-driven render intents for tool events, call
 * pairing by backscan, and the detached history page builder.
 * @module @relay-harness/rlh-host-apiproxy/history-views
 */

import type { Context } from '@relay-harness/cordis'
import type { SessionEvent } from '@relay-harness/rlh-session'
import type { ScopeKey } from '@relay-harness/rlh-scope'
// Type-only: brings the `ctx.tools` Context merge into this program (viewFor reads presenters).
import type {} from '@relay-harness/rlh-tools'
import type { HistoryEntry, ToolEventView } from './api/index.ts'
import { paginate } from './rpc-envelope.ts'

/** Page size when history is called without maxMessages. */
const DEFAULT_MAX_MESSAGES = 50

/** The tool/call payload fields the presenter path reads. */
export interface ToolCallData { callId: string; name: string; arguments: string }

/**
 * Compute the render intent for a tool/call or tool/result event through the
 * presenters registered at this moment; every other event type gets none. A
 * result's presenter needs its call's parsed args — `argsFor` supplies them
 * (live: the per-session call table; history: an in-page backscan), returning
 * undefined when the pairing is unavailable (e.g. the call fell off the page),
 * which soft-falls to no view. Presenter or JSON.parse throws also soft-fall:
 * the client's documented default (generic JSON card) covers every miss.
 * @param ctx - the host context whose registered presenters render the event.
 * @param event - the tool/call or tool/result event to project.
 * @param argsFor - resolves a result's call id to its parsed call pairing.
 * @param scope - the scope chain key whose tool definitions render; undefined sees only the global layer.
 * @returns the render intent, or undefined when no presenter or pairing applies.
 */
export function viewFor(
  ctx: Context,
  event: SessionEvent,
  argsFor: (callId: string) => unknown,
  // Presenters live with the definitions, and definitions live in the scope
  // chain: a preset registers its tools into its standing layer. A live agent
  // is a scope whose chain passes through its preset; a cold read passes the
  // preset's standing key directly — no agent, no resume. An undefined scope
  // sees only the global layer, which is the pre-preset deployment shape.
  scope?: ScopeKey,
): ToolEventView | undefined {
  try {
    if (event.type === 'tool/call') {
      const { name, arguments: raw } = event.data as ToolCallData
      const view = ctx.tools.get(name, scope)?.presentCall?.(JSON.parse(raw))
      return view === undefined ? undefined : { for: 'call', view }
    }
    if (event.type === 'tool/result') {
      const { message, meta } = event.data
      const [result] = message.content
      const callId = message.source.callId
      const call = argsFor(callId) as { name: string; args: unknown } | undefined
      if (call === undefined) return undefined
      const view = ctx.tools.get(call.name, scope)?.presentResult?.(call.args, {
        content: result.content,
        isError: result.isError === true,
        ...meta === undefined ? {} : { meta },
      })
      return view === undefined ? undefined : { for: 'result', view }
    }
  } catch (error: unknown) {
    // A throwing presenter (or unparseable arguments) must not break delivery;
    // the event still ships, just without a view.
    console.error(`api-proxy: presenter failed for ${event.type}, falling back to generic: ${String(error)}`)
  }
  return undefined
}

/**
 * Resolve a tool/result's call pairing by scanning a window of events backwards
 * for the matching tool/call. Used by the history path (the page is the
 * window — a cross-page pairing soft-falls to no view) and by live-path table
 * misses after a reconnect-eviction.
 * @param events - the window scanned backwards for the matching tool/call.
 * @param callId - the result's source call id to pair with.
 * @returns the matching call's name and parsed arguments, or undefined when
 * absent or unparseable.
 */
export function backscanArgs(events: readonly SessionEvent[], callId: string): { name: string; args: unknown } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent
    if (event.type !== 'tool/call') continue
    const data = event.data as ToolCallData
    if (data.callId !== callId) continue
    try {
      return { name: data.name, args: JSON.parse(data.arguments) }
    } catch {
      // Unparseable stored arguments: same soft-fall as a live parse failure.
      return undefined
    }
  }
  return undefined
}

/**
 * Render one detached history page through the same presenter path as ordinary
 * history.
 * @param ctx - the host context whose presenters render each event.
 * @param events - the session's durable events to paginate.
 * @param beforeSeq - exclusive upper seq bound; undefined pages from the newest event.
 * @param maxMessages - message budget for the page; undefined uses the default page size.
 * @param scope - the scope chain key whose tool definitions render.
 * @returns the page's render-intent entries and whether older events remain.
 */
export function historyPage(
  ctx: Context,
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number | undefined,
  scope?: ScopeKey,
): { events: HistoryEntry[]; hasMore: boolean } {
  const page = paginate(events, beforeSeq, maxMessages ?? DEFAULT_MAX_MESSAGES)
  return {
    events: page.events.map((event) => {
      const view = viewFor(ctx, event, callId => backscanArgs(page.events, callId), scope)
      return { event, ...view === undefined ? {} : { view } }
    }),
    hasMore: page.hasMore,
  }
}
