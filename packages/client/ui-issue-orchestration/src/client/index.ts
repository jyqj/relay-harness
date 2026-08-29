/** Browser plugin for the issue automation operator surface. */

import type { ClientContext, SessionId } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type {} from '@relay-harness/rlh-client-ui-layout/client'
import type { IssueOrchestrationSnapshot } from '@relay-harness/rlh-api-remotes/client'
import { IssueOrchestrationAction, type IssueOrchestrationActionInjected } from './IssueOrchestrationAction.tsx'
import { IssueOrchestrationPanel, type IssueOrchestrationPanelInjected } from './IssueOrchestrationPanel.tsx'
import { IssueDashboardController } from './state.ts'
import { en, NS, type IssueOrchestrationKey, zh } from './locales.ts'

declare module '@relay-harness/rlh-client-ui-slots' {
  interface LocaleNamespaceMap {
    issueOrchestration: IssueOrchestrationKey
  }
}

export const inject = ['locale', 'remote', 'remote.issueOrchestration', 'sessions', 'slots']

function unwrap(result: Awaited<ReturnType<ClientContext['remote']['issueOrchestration']['snapshot']>>): IssueOrchestrationSnapshot {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-issue-orchestration: dictionaries')
  const controller = new IssueDashboardController()
  const load = async (): Promise<void> => {
    controller.loading()
    try { controller.loaded(unwrap(await ctx.remote.issueOrchestration.snapshot())) }
    catch (error: unknown) { controller.failed(error instanceof Error ? error.message : String(error)) }
  }
  ctx.effect(() => ctx.remote.$on('issue-orchestration/changed', () => { void load() }), 'ui-issue-orchestration: updates')
  void load()

  const command = async (operation: 'retry' | 'release', issueId: string): Promise<void> => {
    // TODO(types): brand `TrackerIssueId` on the generated remote command payload instead of
    // widening through `as never` (same temporary cast as the other branded-id client commands).
    const result = await ctx.remote.issueOrchestration[operation]({ issueId: issueId as never })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    await load()
  }

  ctx.slots.inject('shell.titlebar.trailing', () => ctx.slots.register({
    name: 'shell.titlebar.trailing', id: 'issue-orchestration', order: 20, locale: NS,
    inject: (): IssueOrchestrationActionInjected => ({
      hooks: { issueDashboard: controller.state },
      openDashboard: () => { controller.open(); void load() },
    }),
  }, IssueOrchestrationAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'issue-orchestration', order: 20, locale: NS,
    inject: (): IssueOrchestrationPanelInjected => ({
      hooks: { issueDashboard: controller.state },
      closeDashboard: () => { controller.close() },
      refreshDashboard: async () => {
        const result = await ctx.remote.issueOrchestration.refresh()
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        await load()
      },
      retryIssue: issueId => command('retry', issueId),
      releaseIssue: issueId => command('release', issueId),
      openSession: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
    }),
  }, IssueOrchestrationPanel))
}
