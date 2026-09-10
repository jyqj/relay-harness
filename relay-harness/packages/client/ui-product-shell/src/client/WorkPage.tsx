import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type {} from '@relay-harness/rlh-client-ui-sidebar/client'
import type { WorkAcceptReceipt, WorkVerifiedReview } from '@relay-harness/rlh-host-work-results/types'
import type { WorkSummary } from './work-projection.ts'
import type { ProductShellKey } from './locales.ts'
import css from './ProductShell.module.css'

export interface WorkPageInjected {
  hooks: { work: { getSnapshot(): WorkSummary; subscribe(listener: () => void): () => void } }
  openDeliverable: (sessionId: string, path: string) => Promise<void>
  acceptWork: (sessionId: string, reviewRevision: number) => Promise<WorkAcceptReceipt>
  verifyWork: (sessionId: string, signal: AbortSignal) => Promise<WorkVerifiedReview>
  openFiles: () => void
}
export type WorkPageProps = PropsRuntime<'sidebar.page'> & PropsLocale<'productShell'> & InjectFace<WorkPageInjected>

/** Render a compact composition of the current Session's existing projections. */
export function WorkPage({ wide, useWork, openDeliverable, acceptWork, verifyWork, openFiles, t }: WorkPageProps) {
  const work = useWork(value => value)
  const request = useRef(0)
  const acceptanceRequest = useRef(0)
  const acceptanceFlight = useRef(false)
  const [verification, setVerification] = useState<{ sessionId: string; epoch: number; value: WorkVerifiedReview } | null>(null)
  const [verificationError, setVerificationError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [superseded, setSuperseded] = useState<{ sessionId: string; epoch: number; revision: number } | null>(null)
  const [checking, setChecking] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [acceptanceError, setAcceptanceError] = useState<{ sessionId: string; revision: number; message: string } | null>(null)
  const [opening, setOpening] = useState<{ sessionId: string | undefined; path: string } | null>(null)
  const [failure, setFailure] = useState<{ sessionId: string | undefined; path: string; message: string } | null>(null)
  useEffect(() => {
    setOpening(null)
    setFailure(null)
    setAcceptanceError(null)
    setAccepting(false)
    acceptanceFlight.current = false
    return () => { request.current += 1; acceptanceRequest.current += 1 }
  }, [work.sessionId, work.epoch, work.availability])
  const reviewRevision = work.acceptance?.reviewRevision
  const acceptedRevision = work.acceptance?.acceptedRevision
  useEffect(() => {
    setVerification(null)
    setVerificationError(null)
    const sessionId = work.sessionId
    if (sessionId === undefined || work.availability !== 'ready' || work.execution !== 'idle' || acceptedRevision === null || acceptedRevision === undefined) {
      setChecking(false)
      return
    }
    const controller = new AbortController()
    setChecking(true)
    void (async () => verifyWork(sessionId, controller.signal))().then((value) => {
      if (controller.signal.aborted) return
      setVerification({ sessionId, epoch: work.epoch, value })
      setChecking(false)
      if (value.current && value.acceptedRevision === value.reviewRevision) setAcceptanceError(null)
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setChecking(false)
      setVerificationError(error instanceof Error ? error.message : String(error))
    })
    return () => { controller.abort() }
  }, [work.sessionId, work.epoch, work.availability, work.execution, reviewRevision, acceptedRevision, refresh, verifyWork])
  const open = (path: string): void => {
    if (work.availability !== 'ready') return
    const id = ++request.current
    const sessionId = work.sessionId
    setOpening({ sessionId, path })
    setFailure(null)
    if (sessionId === undefined) return
    void (async () => openDeliverable(sessionId, path))().then(() => {
      if (id !== request.current) return
      setOpening(null)
    }, (error: unknown) => {
      if (id !== request.current) return
      setOpening(null)
      setFailure({ sessionId, path, message: error instanceof Error ? error.message : String(error) })
    })
  }
  const accept = (): void => {
    const sessionId = work.sessionId
    const revision = work.acceptance?.reviewRevision
    if (sessionId === undefined || revision === undefined || acceptanceFlight.current
      || work.availability !== 'ready' || work.execution !== 'idle' || work.acceptance?.reviewable !== true
      || work.approvals > 0 || work.questions > 0) return
    acceptanceFlight.current = true
    const id = ++acceptanceRequest.current
    setAccepting(true)
    setAcceptanceError(null)
    void (async () => acceptWork(sessionId, revision))().then((receipt) => {
      if (id !== acceptanceRequest.current) return
      acceptanceFlight.current = false
      setAccepting(false)
      setSuperseded(receipt.current ? null : { sessionId, epoch: work.epoch, revision })
      setRefresh(value => value + 1)
    }, (error: unknown) => {
      if (id !== acceptanceRequest.current) return
      acceptanceFlight.current = false
      setAccepting(false)
      setAcceptanceError({ sessionId, revision, message: error instanceof Error ? error.message : String(error) })
      setRefresh(value => value + 1)
    })
  }
  if (!wide) return <div className={css.railMark} aria-label={t('nav.work')}>W</div>
  if (work.sessionId === undefined) return <section className={css.page}><h2>{t('work.title')}</h2><p>{t('work.empty')}</p></section>
  const plan = work.plan?.pending ? t('work.plan.pending') : work.plan?.active ? t('work.plan.on') : t('work.plan.off')
  const execution = t(`work.execution.${work.execution}`)
  const phase = work.goal?.phase
  const goalPhase = phase === undefined ? t('work.goal.empty')
    : phase === 'active' || phase === 'paused' || phase === 'blocked' || phase === 'complete'
      ? t(`work.goal.phase.${phase}`) : phase
  const receipt = work.acceptance
  const failedAcceptance = acceptanceError?.sessionId === work.sessionId && acceptanceError.revision === receipt?.reviewRevision
  const verified = verification?.sessionId === work.sessionId && verification.epoch === work.epoch ? verification.value : undefined
  const supersededCut = superseded?.sessionId === work.sessionId && superseded.epoch === work.epoch && superseded.revision === receipt?.reviewRevision
  const accepted = work.availability === 'ready' && work.execution === 'idle' && receipt !== null && verified?.current === true && verified.reviewRevision === receipt.reviewRevision
    && verified.acceptedRevision === receipt.reviewRevision && !supersededCut && !failedAcceptance && !accepting
  const acceptanceLabel = accepting ? t('work.acceptance.saving') : checking ? t('work.acceptance.checking') : receipt === null ? t('work.acceptance.unavailable') : accepted ? t('work.acceptance.current')
    : receipt.acceptedRevision === null || failedAcceptance || verificationError !== null ? t('work.acceptance.unreviewed') : t('work.acceptance.stale')
  const canAccept = work.availability === 'ready' && receipt?.reviewable === true && work.execution === 'idle' && work.approvals === 0 && work.questions === 0
  const rows: readonly [ProductShellKey, string][] = [
    ['work.goal', work.goal === null ? t('work.goal.empty') : work.goal.objective],
    ['work.goal.phase', goalPhase],
    ['work.plan', plan],
    ['work.jobs', `${work.jobs.running}/${work.jobs.total}`],
    ['work.trajectory', String(work.trajectoryRecords)],
    ['work.deliverables', String(work.deliverables.length)],
    ['work.approvals', String(work.approvals)],
    ['work.questions', String(work.questions)],
    ['work.execution', execution],
    ['work.availability', t(`work.availability.${work.availability}`)],
    ['work.acceptance', acceptanceLabel],
  ]
  return <section className={css.page}>
    <h2>{t('work.title')}</h2>
    <p className={css.scope}>{t('work.scope', { workspace: work.cwd ?? t('work.noWorkspace'), session: work.sessionId })}</p>
    {work.availability !== 'ready' ? <p role="status">{t('work.staleFacts')}</p> : null}
    {work.availability === 'ready' && (work.approvals > 0 || work.questions > 0) ? <p role="status">{t('work.attention', { approvals: work.approvals, questions: work.questions })}</p> : null}
    {canAccept && !accepted && !accepting && !checking ? <p role="status">{t('work.reviewReady')}</p> : null}
    {work.jobs.failed > 0 || work.jobs.killed > 0 ? <p role="status">{t('work.jobOutcomes', { failed: work.jobs.failed, killed: work.jobs.killed })}</p> : null}
    <dl className={css.metrics}>{rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd title={value}>{value}</dd></div>)}</dl>
    <p>{t('work.acceptance.description')}</p>
    <button type="button" className={css.filesButton} disabled={!canAccept || accepting || accepted} onClick={accept}>{accepting ? t('work.acceptance.saving') : t('work.acceptance.confirm')}</button>
    {verificationError !== null ? <p role="alert">{t('work.acceptance.checkFailed', { message: verificationError })}</p> : null}
    {failedAcceptance ? <p role="alert">{t('work.acceptance.failed', { message: acceptanceError.message })}</p> : null}
    <button type="button" className={css.filesButton} disabled={work.cwd === undefined || work.availability !== 'ready'} title={work.cwd} onClick={openFiles}>{t('work.files')}</button>
    {work.unindexedResults === null ? <p>{t('work.inventoryUnavailable')}</p>
      : work.unindexedResults > 0 ? <p>{t('work.inventoryIncomplete', { count: work.unindexedResults })}</p> : null}
    {work.deliverables.length > 0 ? <ul className={css.deliverables}>{work.deliverables.map(path => <li key={path}><button type="button" title={path} disabled={work.availability !== 'ready' || (opening !== null && opening.sessionId === work.sessionId && opening.path === path)} onClick={() => { open(path) }}>{path}</button></li>)}</ul> : null}
    {failure !== null && failure.sessionId === work.sessionId ? <div role="alert" className={css.openError}>
      <p>{t('work.openFailed', { message: failure.message })}</p>
      <button type="button" onClick={() => { open(failure.path) }}>{t('work.retry')}</button>
      <button type="button" onClick={() => { request.current += 1; setFailure(null); setOpening(null) }}>{t('work.dismiss')}</button>
    </div> : null}
  </section>
}
