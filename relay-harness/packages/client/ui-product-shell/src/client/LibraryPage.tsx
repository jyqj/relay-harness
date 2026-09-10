import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type {} from '@relay-harness/rlh-client-ui-sidebar/client'
import type { ConnectionHandle } from '@relay-harness/rlh-api-remotes/client'
import type { WorkLibraryEntry, WorkLibraryPage, WorkLibraryRequest } from '@relay-harness/rlh-host-work-results/types'
import { mergeLibraryPage, type LibraryScan } from './library-scan.ts'
import css from './ProductShell.module.css'

export interface LibraryPageInjected {
  hooks: { connection: ConnectionHandle['readiness'] }
  openFiles: () => void
  openSettings: (section: 'memory' | 'skills' | 'mcp' | 'code-index') => void
  queryLibrary: (request: WorkLibraryRequest, signal: AbortSignal) => Promise<WorkLibraryPage>
  openLibraryOutput: (entry: WorkLibraryEntry) => Promise<void>
}
export type LibraryPageProps = PropsRuntime<'sidebar.page'> & PropsLocale<'productShell'> & InjectFace<LibraryPageInjected>

/** Search only execution-recorded outputs from existing Sessions, with explicit page coverage. */
export function LibraryPage({ wide, useSessions, useConnection, openFiles, openSettings, queryLibrary, openLibraryOutput, t }: LibraryPageProps) {
  const connection = useConnection(value => value)
  const ready = connection.phase === 'ready'
  const submittedQuery = useRef('')
  const hasSession = useSessions(state => state.current !== undefined)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [scan, setScan] = useState<{ epoch: number; value: LibraryScan } | null>(null)
  const entries = scan?.value.entries ?? []
  const page = scan?.value.page ?? null
  const currentScan = ready && scan?.epoch === connection.epoch
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const generation = useRef(0)
  const openGeneration = useRef(0)
  const active = useRef<AbortController | null>(null)
  const load = useCallback((text: string, next: WorkLibraryPage['next'] = null): void => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    const id = ++generation.current
    setLoading(true)
    setError(null)
    setLoadError(null)
    openGeneration.current += 1
    setOpening(null)
    if (next === null) { setScan(null); setSubmitted(text); submittedQuery.current = text }
    void (async () => queryLibrary({ query: text, ...next ?? {} }, controller.signal))().then((value) => {
      if (id !== generation.current) return
      setScan(previous => ({ epoch: connection.epoch, value: mergeLibraryPage(
        next !== null && previous?.epoch === connection.epoch ? previous.value : null, value,
      ) }))
      setLoading(false)
    }, (failure: unknown) => {
      if (id !== generation.current) return
      setLoadError(failure instanceof Error ? failure.message : String(failure))
      setLoading(false)
    })
  }, [queryLibrary, connection.epoch])
  useEffect(() => {
    if (!wide || !ready) { setLoading(false); setOpening(null); return }
    load(submittedQuery.current)
    return () => { generation.current += 1; openGeneration.current += 1; active.current?.abort() }
  }, [load, wide, ready, connection.epoch])
  const open = (entry: WorkLibraryEntry): void => {
    if (!currentScan) return
    const id = ++openGeneration.current
    setOpening(JSON.stringify([entry.sessionId, entry.path]))
    setError(null)
    void (async () => openLibraryOutput(entry))().then(() => {
      if (id === openGeneration.current) setOpening(null)
    }, (failure: unknown) => {
      if (id !== openGeneration.current) return
      setOpening(null)
      setError(failure instanceof Error ? failure.message : String(failure))
    })
  }
  const hasGaps = scan?.value.hadUnindexedResults === true || scan?.value.hadUnavailableSessions === true
  if (!wide) return <div className={css.railMark} aria-label={t('nav.library')}>L</div>
  return <section className={css.page}>
    <h2>{t('library.title')}</h2>
    <form className={css.librarySearch} onSubmit={(event) => { event.preventDefault(); if (ready) load(query) }}>
      <input aria-label={t('library.search')} placeholder={t('library.search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <button type="submit" disabled={!ready}>{t('library.searchAction')}</button>
    </form>
    <p>{t('library.scope')}</p>
    {!ready ? <p role="status">{t('library.reconnecting')}</p> : null}
    {loading ? <p role="status">{t('library.loading')}</p> : null}
    {page !== null ? <p role="status">{t('library.coverage', { scanned: page.scannedSessions, total: page.totalSessions })} {page.next === null ? t(hasGaps ? 'library.endIncomplete' : 'library.complete') : t('library.partial')}</p> : null}
    {page !== null && page.unindexedResults > 0 ? <p>{t('library.pageUnindexed', { count: page.unindexedResults })}</p> : null}
    {page !== null && page.unavailableSessions > 0 ? <p>{t('library.unavailable', { count: page.unavailableSessions })}</p> : null}
    {scan?.value.hadUnindexedResults && page?.unindexedResults === 0 ? <p>{t('library.priorUnindexed')}</p> : null}
    {scan?.value.hadUnavailableSessions && page?.unavailableSessions === 0 ? <p>{t('library.priorUnavailable')}</p> : null}
    {loadError !== null ? <div role="alert" className={css.openError}>
      <p>{loadError}</p>
      <button type="button" disabled={loading || !ready} onClick={() => { load(submitted, page?.next ?? null) }}>{t('library.retryPage')}</button>
      {page !== null ? <button type="button" disabled={loading || !ready} onClick={() => { load(submitted) }}>{t('library.restart')}</button> : null}
    </div> : null}
    {error !== null ? <p role="alert">{error}</p> : null}
    <ul className={css.deliverables}>{entries.map((entry) => {
      const key = JSON.stringify([entry.sessionId, entry.path])
      return <li key={key}><button type="button" title={entry.path} disabled={!currentScan || opening === key} onClick={() => { open(entry) }}>{entry.path}</button><small>{entry.cwd ?? entry.sessionId}</small></li>
    })}</ul>
    {!loading && entries.length === 0 && page !== null ? <p>{t('library.empty')}</p> : null}
    {page?.next !== null && page?.next !== undefined ? <button type="button" className={css.filesButton} disabled={loading || !currentScan || loadError !== null} onClick={() => { if (currentScan) load(submitted, page.next) }}>{t('library.more')}</button> : null}
    <div className={css.libraryGrid}>
      <button type="button" disabled={!ready || !hasSession} onClick={openFiles}>{t('library.files')}</button>
      <button type="button" onClick={() => { openSettings('memory') }}>{t('library.memory')}</button>
      <button type="button" onClick={() => { openSettings('skills') }}>{t('library.skills')}</button>
      <button type="button" onClick={() => { openSettings('mcp') }}>{t('library.mcp')}</button>
      <button type="button" onClick={() => { openSettings('code-index') }}>{t('library.index')}</button>
    </div>
    {!hasSession ? <p>{t('library.noSession')}</p> : null}
  </section>
}
