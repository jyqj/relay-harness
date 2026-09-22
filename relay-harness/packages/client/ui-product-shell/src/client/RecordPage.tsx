/** Passive Work and history inspection; execution starts only through the explicit conversation action. */
import { useEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { ConnectionHandle } from '@relay-harness/rlh-api-remotes/client'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'
import type { WorkView, WorkHistoryPage, WorkHistoryRequest } from '@relay-harness/rlh-host-work-results/types'
import type { ProductRoute } from './navigation.ts'
import css from './ProductShell.module.css'

/** Passive reads and explicit user navigation; no mutation is retried on reconnect. */
export interface RecordPageInjected {
  hooks: { route: HostObservable<ProductRoute>; connection: ConnectionHandle['readiness'] }
  inspect: (id: SessionId, signal: AbortSignal) => Promise<WorkView>
  history: (request: WorkHistoryRequest, signal: AbortSignal) => Promise<WorkHistoryPage>
  openRecord: (id: SessionId) => void
  openConversation: (id: SessionId) => void
}
export type RecordPageProps = PropsRuntime<'shell.page'> & PropsLocale<'productShell'> & InjectFace<RecordPageInjected>

/** Render source cuts, execution/recovery observations and bounded final text without activating Agents.
 * @param props - Read actions, route/connection observables and translated copy.
 * @returns A source-specific page retaining no false success across navigation generations.
 */
export function RecordPage({ active, useRoute, useConnection, inspect, history, openRecord, openConversation, t }: RecordPageProps) {
  const route = useRoute(value => value)
  const connection = useConnection(value => value)
  const sessionId = route.page === 'record' && 'sessionId' in route ? route.sessionId : undefined
  const [view, setView] = useState<WorkView | null>(null)
  const [pages, setPages] = useState<WorkHistoryPage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const ready = active && connection.phase === 'ready'
  useEffect(() => {
    const id = ++generation.current
    controller.current?.abort()
    setView(null); setPages([]); setError(null); setLoading(false)
    if (!ready || sessionId === undefined) return
    const operation = new AbortController()
    controller.current = operation
    setLoading(true)
    void Promise.all([inspect(sessionId, operation.signal), history({ sessionId }, operation.signal)]).then(([snapshot, page]) => {
      if (operation.signal.aborted || id !== generation.current) return
      setView(snapshot); setPages([page]); setLoading(false)
    }, (failure: unknown) => {
      if (operation.signal.aborted || id !== generation.current) return
      setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false)
    })
    return () => { operation.abort(); generation.current += 1 }
  }, [sessionId, ready, connection.epoch, refresh, inspect, history])
  const more = (): void => {
    const beforeSeq = pages[0]?.nextBeforeSeq
    if (!ready || loading || sessionId === undefined || beforeSeq == null) return
    const id = generation.current
    const operation = controller.current
    if (operation === null || operation.signal.aborted) return
    setLoading(true); setError(null)
    void history(
      { sessionId, beforeSeq, ...(pages[0] === undefined ? {} : { snapshot: pages[0].snapshot }) }, operation.signal,
    ).then((page) => {
      if (operation.signal.aborted || id !== generation.current) return
      if (page.throughSeq < beforeSeq - 1) { setError(t('record.changed')); setLoading(false); return }
      setPages(previous => [page, ...previous]); setLoading(false)
    }, (failure: unknown) => {
      if (operation.signal.aborted || id !== generation.current) return
      setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false)
    })
  }
  return <section className={css.page} data-record-page>
    <header className={css.pageHeading}><div><p className={css.eyebrow}>{t('record.title')}</p><h2>{sessionId ?? t('record.invalid')}</h2><p>{t('record.passive')}</p></div>
      <button type="button" disabled={!ready || loading || sessionId === undefined} onClick={() => { setRefresh(value => value + 1) }}>{t('record.refresh')}</button>
    </header>
    {!ready ? <p role="status">{t('work.staleFacts')}</p> : null}
    {loading ? <p role="status">{t('record.loading')}</p> : null}
    {error !== null ? <p role="alert">{error}</p> : null}
    {view === null ? null : <>
      <section className={css.card}><h3>{t('record.facts')}</h3>
        <p>{t('record.cut', { seq: view.source.throughSeq })}</p>
        <p>{t('work.goal.phase')}: {view.goal === null ? t('work.goal.empty') : `${view.goal.objective} · ${view.goal.phase} · #${view.goal.revision}`}</p>
        <p>{t('work.execution')}: {view.execution.activity} · {view.source.resident ? t('record.resident') : t('record.cold')}</p>
        <p>{t('record.confirmScope')}</p>
        {view.coverage.missing.length > 0 ? <p role="status">{t('record.gaps')}: {view.coverage.missing.join(' · ')}</p> : null}
        <button type="button" disabled={!ready} onClick={() => { openConversation(view.relation === 'delegated' ? view.parentSessionId ?? view.sessionId : view.sessionId) }}>{t(view.relation === 'delegated' ? 'record.openOwner' : 'work.openConversation')}</button>
      </section>
      <section className={css.card}><h3>{t('work.activity.title')}</h3><p>{t('record.executionScope')}</p>
        <ul>{view.execution.entries.map(entry => <li key={`${entry.kind}:${entry.id}`}>
          <button type="button" disabled={!ready} onClick={() => { openRecord(entry.sessionId) }}>{entry.label}</button>
          <span> · {entry.kind}{entry.relationship === undefined ? '' : ` · ${entry.relationship.kind}`} · {entry.activity} · {entry.recovery}{entry.recoveryCapabilities === undefined ? '' : ` · resume ${entry.recoveryCapabilities.resume}`}{entry.outcome === undefined ? '' : ` · ${entry.outcome}`}</span>
        </li>)}</ul>
        {view.execution.omitted > 0 ? <p>{t('record.omitted', { count: view.execution.omitted })}</p> : null}
      </section>
      <section className={css.card}><h3>{t('record.context')}</h3><p>{t('record.capabilityScope')}</p>
        <p>{view.capabilities.activationRequired ? t('record.activationRequired') : view.capabilities.contextSources.map(source => source.id).join(' · ') || t('record.noSources')}</p>
      </section>
    </>}
    <section className={css.card}><h3>{t('record.history')}</h3><p>{t('record.historyScope')}</p>
      {pages[0]?.nextBeforeSeq != null ? <button type="button" disabled={!ready || loading} onClick={more}>{t('record.more')}</button> : null}
      {pages.flatMap(page => page.rows).map(row => <article key={row.seq}><h4>{row.kind} · #{row.seq}</h4><pre className={css.historyText}>{row.text}</pre>{row.truncated ? <p>{t('record.truncated')}</p> : null}</article>)}
    </section>
  </section>
}
