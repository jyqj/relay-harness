import { useState, type ReactNode } from 'react'
import type { IssueOrchestrationEntry } from '@relay-harness/rlh-api-remotes/client'
import type { SessionId } from '@relay-harness/rlh-client-connection/client'
import type { SnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { IssueDashboardState } from './state.ts'
import css from './IssueOrchestrationPanel.module.css'

export interface IssueOrchestrationPanelInjected {
  hooks: { issueDashboard: SnapshotStore<IssueDashboardState> }
  closeDashboard: () => void
  refreshDashboard: () => Promise<void>
  retryIssue: (issueId: string) => Promise<void>
  releaseIssue: (issueId: string) => Promise<void>
  openSession: (sessionId: SessionId) => void
}

export type IssueOrchestrationPanelProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'issueOrchestration'>
  & InjectFace<IssueOrchestrationPanelInjected>

function date(value: number): string {
  return new Date(value).toLocaleString()
}

function EntryCard({ entry, kind, pending, onRetry, onRelease, openSession, t }: {
  readonly entry: IssueOrchestrationEntry
  readonly kind: 'running' | 'retrying' | 'blocked'
  readonly pending: boolean
  readonly onRetry: () => void
  readonly onRelease: () => void
  readonly openSession: IssueOrchestrationPanelInjected['openSession']
  readonly t: IssueOrchestrationPanelProps['t']
}) {
  return (
    <article className={css.card} data-status={kind}>
      <header className={css.cardHead}>
        <div><strong>{entry.issue.identifier}</strong><span className={css.state}>{entry.issue.state}</span></div>
        <span className={css.status}>{t(kind)}</span>
      </header>
      <p className={css.title}>{entry.issue.title}</p>
      <p className={css.attempt}>{t('attempt', { attempt: entry.attempt })}</p>
      <dl className={css.meta}>
        {entry.workspacePath !== undefined ? <><dt>{t('workspace')}</dt><dd>{entry.workspacePath}</dd></> : null}
        {entry.sessionId !== undefined ? <><dt>{t('session')}</dt><dd>{entry.sessionId}</dd></> : null}
        {entry.lastProgressAt !== undefined ? <><dt>{t('lastProgress')}</dt><dd>{date(entry.lastProgressAt)}</dd></> : null}
        {entry.nextRetryAt !== undefined ? <><dt>{t('nextRetry')}</dt><dd>{date(entry.nextRetryAt)}</dd></> : null}
        {entry.error !== undefined ? <><dt>{t('error')}</dt><dd className={css.error}>{entry.error}</dd></> : null}
      </dl>
      <footer className={css.actions}>
        {entry.sessionId !== undefined ? <button type="button" onClick={() => { openSession(entry.sessionId as SessionId) }}>{t('openSession')}</button> : null}
        {kind !== 'running' ? <button type="button" disabled={pending} onClick={onRetry}>{t('retry')}</button> : null}
        {kind !== 'running' ? <button type="button" disabled={pending} onClick={onRelease}>{t('release')}</button> : null}
      </footer>
    </article>
  )
}

function Section({ title, entries, kind, children }: {
  readonly title: string
  readonly entries: readonly IssueOrchestrationEntry[]
  readonly kind: 'running' | 'retrying' | 'blocked'
  readonly children: (entry: IssueOrchestrationEntry) => ReactNode
}) {
  if (entries.length === 0) return null
  return (
    <section className={css.section} data-section={kind}>
      <h3>{title}<span>{entries.length}</span></h3>
      <div className={css.grid}>{entries.map(children)}</div>
    </section>
  )
}

export function IssueOrchestrationPanel({
  useIssueDashboard, closeDashboard, refreshDashboard, retryIssue, releaseIssue, openSession, t,
}: IssueOrchestrationPanelProps) {
  const state = useIssueDashboard(value => value)
  const [pending, setPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  if (!state.open) return null
  const act = (key: string, action: () => Promise<void>): void => {
    setPending(key); setActionError(null)
    void action().catch((error: unknown) => { setActionError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setPending(null) })
  }
  const render = (kind: 'running' | 'retrying' | 'blocked') => (entry: IssueOrchestrationEntry) => (
    <EntryCard
      key={entry.issue.id}
      entry={entry}
      kind={kind}
      pending={pending === entry.issue.id}
      onRetry={() => { act(entry.issue.id, () => retryIssue(entry.issue.id)) }}
      onRelease={() => { act(entry.issue.id, () => releaseIssue(entry.issue.id)) }}
      openSession={openSession}
      t={t}
    />
  )
  const snapshot = state.snapshot
  const empty = snapshot !== undefined
    && snapshot.running.length + snapshot.retrying.length + snapshot.blocked.length === 0
  return (
    <div
      className={css.backdrop}
      data-shell-modal-overlay
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeDashboard() }}
    >
      <div className={css.panel} role="dialog" aria-modal="true" aria-label={t('title')}>
        <header className={css.head}>
          <div>
            <h2>{t('title')}</h2>
            {snapshot !== undefined ? (
              <p>{snapshot.checking ? t('checking') : t('ready')} · {t('workflow')}: {snapshot.workflowRevision.slice(0, 8)}</p>
            ) : null}
          </div>
          <div className={css.headActions}><button type="button" onClick={() => { act('refresh', refreshDashboard) }} disabled={state.loading}>{t('refresh')}</button><button type="button" onClick={closeDashboard} aria-label={t('close')}>×</button></div>
        </header>
        <div className={css.body}>
          {state.loading && snapshot === undefined ? <p className={css.message}>{t('loading')}</p> : null}
          {state.error !== undefined ? <p className={css.failure}>{t('loadFailed', { message: state.error })}</p> : null}
          {actionError !== null ? <p className={css.failure}>{t('actionFailed', { message: actionError })}</p> : null}
          {empty ? <p className={css.message}>{t('empty')}</p> : null}
          {snapshot !== undefined ? <>
            <Section title={t('blocked')} entries={snapshot.blocked} kind="blocked">{render('blocked')}</Section>
            <Section title={t('running')} entries={snapshot.running} kind="running">{render('running')}</Section>
            <Section title={t('retrying')} entries={snapshot.retrying} kind="retrying">{render('retrying')}</Section>
          </> : null}
        </div>
      </div>
    </div>
  )
}
