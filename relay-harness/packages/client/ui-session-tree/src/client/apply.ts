/** Native Session Tree registration and service orchestration. */

import type { ConnectionHandle, SessionId, WorkspaceId } from '@relay-harness/rlh-client-connection/client'
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type {} from '@relay-harness/rlh-client-ui-conversation/client'
import type {} from '@relay-harness/rlh-client-ui-layout/client'
import { SessionTreeAction, type SessionTreeActionInjected } from './SessionTreeAction.tsx'
import { SessionTreeCanvas, type SessionTreeCanvasInjected } from './SessionTreeCanvas.tsx'
import { SessionTreeTitlebarAction, type SessionTreeTitlebarActionInjected } from './SessionTreeTitlebarAction.tsx'
import { SessionTreeController } from './controller.ts'
import { readCompleteHistory } from './history.ts'
import { en, NS, zh } from './locales.ts'
import { createSessionTreeStore } from './store.ts'

/** Required services for typed history, Session actions, locale, and the two native slots. */
export const inject = ['connection', 'locale', 'sessions', 'slots', 'workspaces']

/** Register the root overlay and its per-session opener. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-tree: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new SessionTreeController()
  const store = createSessionTreeStore()

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-tree',
    order: 10,
    locale: NS,
    store,
    inject: (): SessionTreeCanvasInjected => ({
      hooks: { treeOpen: controller.state },
      closeTree: () => { controller.close() },
      loadHistory: (sessionId, signal) => readCompleteHistory(connection.api, sessionId, signal),
      openSession: (sessionId) => { ctx.sessions.open(sessionId) },
      forkSession: async input => ctx.sessions.fork({ ...input, increaseTitle: true }),
      sendMessage: async (sessionId, text) => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error(`session tree: session "${sessionId}" is unavailable`)
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      },
      startSession: (workspaceId?: WorkspaceId) => { ctx.workspaces.startSession(workspaceId) },
      archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId) },
    }),
  }, SessionTreeCanvas))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'session-tree',
    order: 15,
    locale: NS,
    inject: (sessionId: SessionId): SessionTreeActionInjected => ({
      openTree: () => { controller.open(sessionId) },
    }),
  }, SessionTreeAction))

  ctx.slots.inject('shell.titlebar.trailing', () => ctx.slots.register({
    name: 'shell.titlebar.trailing',
    id: 'session-tree',
    order: 15,
    locale: NS,
    inject: (): SessionTreeTitlebarActionInjected => ({
      openTree: (sessionId) => { controller.open(sessionId) },
    }),
  }, SessionTreeTitlebarAction))
}
