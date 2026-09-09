import { useEffect, useRef, useState } from 'react'
import type { CodeIndexManagementStatus, CodeIndexSearchDebugResult } from '@relay-harness/rlh-api-remotes/client'
import { Button, Input, Modal, Pill } from '@relay-harness/rlh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { CodeIndexCenterLocaleKey } from './locales.ts'
import styles from './CodeIndexCenterSection.module.css'

export interface CodeIndexCenterInjected {
  status: (sessionId: string, fresh?: boolean) => Promise<CodeIndexManagementStatus>
  refresh: (sessionId: string) => Promise<CodeIndexManagementStatus>
  reconcile: (sessionId: string) => Promise<CodeIndexManagementStatus>
  rebuild: (sessionId: string) => Promise<CodeIndexManagementStatus>
  search: (sessionId: string, query: string) => Promise<CodeIndexSearchDebugResult>
  t: (key: CodeIndexCenterLocaleKey) => string
}
export type CodeIndexCenterSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.codeIndex'> & InjectFace<CodeIndexCenterInjected>

export function CodeIndexCenterSection(props: CodeIndexCenterSectionProps) {
  const sessionId = props.useSessions(state => state.current)
  const selectedSession = useRef(sessionId)
  selectedSession.current = sessionId
  const operation = useRef(0)
  const [status, setStatus] = useState<CodeIndexManagementStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [confirm, setConfirm] = useState<string>()
  const [token, setToken] = useState('')
  const [query, setQuery] = useState('')
  const [debug, setDebug] = useState<CodeIndexSearchDebugResult>()

  const load = (owner: string, action: () => Promise<CodeIndexManagementStatus>) => {
    const id = ++operation.current
    setBusy(true); setError(false)
    void action().then((value) => {
      if (operation.current === id && selectedSession.current === owner) setStatus(value)
    }).catch(() => {
      if (operation.current === id && selectedSession.current === owner) setError(true)
    }).finally(() => {
      if (operation.current === id && selectedSession.current === owner) setBusy(false)
    })
  }

  useEffect(() => {
    operation.current += 1
    setStatus(undefined); setDebug(undefined); setError(false); setBusy(false)
    setConfirm(undefined); setToken('')
    if (sessionId !== undefined) load(sessionId, () => props.status(sessionId, false))
  }, [props.status, sessionId])

  const runSearch = () => {
    if (sessionId === undefined || query.trim() === '' || busy) return
    const owner = sessionId; const id = ++operation.current
    setBusy(true); setError(false)
    void props.search(owner, query.trim()).then((value) => {
      if (operation.current === id && selectedSession.current === owner) setDebug(value)
    }).catch(() => {
      if (operation.current === id && selectedSession.current === owner) setError(true)
    }).finally(() => {
      if (operation.current === id && selectedSession.current === owner) setBusy(false)
    })
  }

  return <div className={styles.section}>
    <div className={styles.heading}>
      <div><h2>{props.t('title')}</h2><p>{props.t('intro')}</p></div>
      <div className={styles.actions}>
        <Button disabled={busy || sessionId === undefined} onClick={() => {
          if (sessionId !== undefined) load(sessionId, () => props.refresh(sessionId))
        }}>{props.t('refresh')}</Button>
        <Button disabled={busy || sessionId === undefined} variant="outline" onClick={() => {
          if (sessionId !== undefined) load(sessionId, () => props.reconcile(sessionId))
        }}>{props.t('reconcile')}</Button>
        <Button disabled={busy || sessionId === undefined} variant="outline" onClick={() => {
          setToken(''); setConfirm(sessionId)
        }}>{props.t('rebuild')}</Button>
      </div>
    </div>
    {sessionId === undefined ? <p role="status">{props.t('noWorkspace')}</p> : null}
    {busy && status === undefined ? <p role="status">{props.t('loading')}</p> : null}
    {error ? <p role="alert" className={styles.error}>{props.t('error')}</p> : null}
    {status ? <>
      <p className={styles.code}>{props.t('workspace')}: {status.workspaceRoot}</p>
      <div className={styles.cards}>
        <Card label={props.t('files')} value={status.indexedFileCount}/>
        <Card label={props.t('chunks')} value={status.chunkCount}/>
        <Card label={props.t('health')} value={status.degraded ? 'degraded' : 'ready'}/>
        <Card label={props.t('epochs')} value={`${status.epochs.indexEpoch}/${status.epochs.embeddingEpoch ?? 0}`}/>
      </div>
      <section>
        <h3>{props.t('generations')}</h3>
        <div className={styles.generations}>{status.generations.length === 0
          ? <p className={styles.muted}>{props.t('noGenerations')}</p>
          : status.generations.map(generation => <article className={styles.generation} key={generation.generationId}>
            <div className={styles.generationTop}>
              <strong>{generation.model}</strong><Pill>{generation.dimensionMode}</Pill>
            </div>
            <div className={styles.code}>{generation.generationId}</div>
            <p>
              {props.t('coverage')}: {generation.vectorizedChunks}/{status.chunkCount} ·{' '}
              {props.t('backlog')}: {generation.pendingJobs + generation.runningJobs} ·{' '}
              {props.t('failed')}: {generation.failedJobs}
            </p>
            {generation.lastError ? <p className={styles.error}>{generation.lastError}</p> : null}
          </article>)}</div>
      </section>
      {status.lastRefresh?.explain ? <section className={styles.build}><h3>{props.t('build')}</h3><pre>{JSON.stringify(status.lastRefresh.explain, null, 2)}</pre></section> : null}
      {status.lastError ? <p className={styles.error}>{props.t('lastError')}: {status.lastError}</p> : null}
    </> : null}
    <section className={styles.debug}>
      <h3>{props.t('search')}</h3>
      <div className={styles.search}>
        <Input value={query} placeholder={props.t('searchPlaceholder')} onChange={(event) => {
          setQuery(event.target.value)
        }} onKeyDown={(event) => {
          if (event.key === 'Enter') runSearch()
        }}/>
        <Button disabled={busy || sessionId === undefined || query.trim() === ''} onClick={runSearch}>
          {props.t('run')}
        </Button>
      </div>
      {debug ? <ul className={styles.hits}>{debug.result.hits.length === 0
        ? <li>{props.t('noHits')}</li>
        : debug.result.hits.map(hit => <li className={styles.hit} key={hit.chunkId}>
          <strong className={styles.code}>{hit.filePath}:{hit.startLine}-{hit.endLine}</strong>
          <div>{props.t('score')}: {hit.score.toFixed(4)} · {props.t('reasons')}: {hit.reasons.join(', ')}</div>
        </li>)}</ul> : null}
    </section>
    <Modal
      open={confirm !== undefined && confirm === sessionId}
      onClose={() => { setConfirm(undefined) }}
      title={props.t('rebuildTitle')}
      closeLabel={props.t('cancel')}
      footer={<>
        <Button variant="outline" onClick={() => { setConfirm(undefined) }}>{props.t('cancel')}</Button>
        <Button disabled={token !== 'REBUILD' || busy || sessionId === undefined} onClick={() => {
          if (sessionId === undefined || confirm !== sessionId) return
          const owner = sessionId
          setConfirm(undefined)
          setToken('')
          load(owner, () => props.rebuild(owner))
        }}>{props.t('confirm')}</Button>
      </>}
    >
      <p>{props.t('rebuildHint')}</p>
      <Input value={token} onChange={(event) => { setToken(event.target.value) }} aria-label="REBUILD"/>
    </Modal>
  </div>
}
function Card({ label, value }: { label: string; value: string | number }) {
  return <div className={styles.card}>
    <div className={styles.muted}>{label}</div><div className={styles.value}>{value}</div>
  </div>
}
