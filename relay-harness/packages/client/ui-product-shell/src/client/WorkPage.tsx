import { useEffect, useId, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type {} from '@relay-harness/rlh-client-ui-layout/client'
import type { WorkAcceptReceipt, WorkContentReviewRead, WorkVerifiedReview } from '@relay-harness/rlh-host-work-results/types'
import type { WorkSummary } from './work-projection.ts'
import css from './ProductShell.module.css'

export interface WorkPageInjected {
  hooks: { work: { getSnapshot(): WorkSummary; subscribe(listener: () => void): () => void } }
  openDeliverable: (sessionId: string, path: string) => Promise<void>
  acceptWork: (sessionId: string, reviewRevision: number) => Promise<WorkAcceptReceipt>
  verifyWork: (sessionId: string, signal: AbortSignal) => Promise<WorkVerifiedReview>
  /** Read-only latest content review plus per-version currency; submission stays out of this page. */
  contentReview: (sessionId: string, signal: AbortSignal) => Promise<WorkContentReviewRead>
  openFiles: () => void
  openConversation: (sessionId: string) => void
  startWork: () => void
}
export type WorkPageProps = PropsRuntime<'shell.page'> & PropsRenderSlots<'work.activity'> & PropsLocale<'productShell'> & InjectFace<WorkPageInjected>

/** Render attention, execution, and version-bound record confirmation in the main workspace. */
export function WorkPage(
  { active, renderSlot, useWork, openConversation, startWork, openDeliverable, acceptWork, verifyWork, contentReview, openFiles, t }:
  WorkPageProps,
) {
  const blockerId = useId()
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
  }, [work.sessionId, work.epoch, work.availability, active])
  const reviewRevision = work.acceptance?.reviewRevision
  const acceptedRevision = work.acceptance?.acceptedRevision
  useEffect(() => {
    setVerification(null)
    setVerificationError(null)
    const sessionId = work.sessionId
    if (!active || sessionId === undefined || work.availability !== 'ready' || work.execution !== 'idle' || reviewRevision === undefined || work.approvals > 0 || work.questions > 0) {
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
  }, [work.sessionId, work.epoch, work.availability, work.execution, reviewRevision, acceptedRevision, refresh,
    verifyWork, active, work.approvals, work.questions])
  const [contentReviewState, setContentReviewState] = useState<{ sessionId: string; epoch: number; value: WorkContentReviewRead } | null>(null)
  useEffect(() => {
    const sessionId = work.sessionId
    if (!active || sessionId === undefined || work.availability !== 'ready') {
      setContentReviewState(null)
      return
    }
    const controller = new AbortController()
    void (async () => contentReview(sessionId, controller.signal))().then((value) => {
      if (controller.signal.aborted) return
      setContentReviewState({ sessionId, epoch: work.epoch, value })
    }, () => {
      // A failed read renders no content-review state rather than a fabricated one.
      if (controller.signal.aborted) return
      setContentReviewState(null)
    })
    return () => { controller.abort() }
  }, [work.sessionId, work.epoch, work.availability, active, contentReview, refresh])
  const open = (path: string): void => {
    if (!active || work.availability !== 'ready') return
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
      || !active || work.availability !== 'ready' || work.execution !== 'idle' || work.acceptance?.reviewable !== true
      || work.approvals > 0 || work.questions > 0 || !canAccept) return
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
  if (work.sessionId === undefined) return <section className={css.page} data-work-page>
    <div className={css.emptyState}><h2>{t('work.empty.title')}</h2><p>{t('work.empty')}</p>
      <button type="button" className={css.filesButton} onClick={startWork}>{t('work.start')}</button>
    </div>
  </section>
  const plan = work.plan?.pending ? t('work.plan.pending') : work.plan?.active ? t('work.plan.on') : t('work.plan.off')
  const execution = t(`work.execution.${work.execution}`)
  const phase = work.goal?.phase
  const goalPhase = phase === undefined ? t('work.goal.empty')
    : phase === 'active' || phase === 'paused' || phase === 'blocked' || phase === 'complete'
      ? t(`work.goal.phase.${phase}`) : phase
  const receipt = work.acceptance
  const failedAcceptance = acceptanceError?.sessionId === work.sessionId && acceptanceError.revision === receipt?.reviewRevision
  const verified = verification?.sessionId === work.sessionId && verification.epoch === work.epoch ? verification.value : undefined
  const contentRead = contentReviewState?.sessionId === work.sessionId && contentReviewState.epoch === work.epoch
    ? contentReviewState.value : undefined
  // The worst currency state is the honest aggregate: one stale version makes the whole review stale.
  const contentState = contentRead === undefined || contentRead.review === null ? undefined
    : contentRead.currency.some(entry => entry.state === 'changed-unreviewed') ? 'changed-unreviewed'
      : contentRead.currency.some(entry => entry.state === 'not-reverified') ? 'not-reverified'
        : contentRead.currency.length > 0 ? 'matches-confirmed' : undefined
  const supersededCut = superseded?.sessionId === work.sessionId && superseded.epoch === work.epoch
    && superseded.revision === receipt?.reviewRevision
  const accepted = work.availability === 'ready' && work.execution === 'idle' && receipt !== null && verified?.current === true && verified.reviewRevision === receipt.reviewRevision
    && verified.acceptedRevision === receipt.reviewRevision && receipt.acceptedRevision === verified.acceptedRevision
    && !supersededCut && !failedAcceptance && !accepting
  const acceptanceLabel = accepting ? t('work.acceptance.saving') : checking ? t('work.acceptance.checking') : receipt === null ? t('work.acceptance.unavailable') : accepted ? t('work.acceptance.current')
    : receipt.acceptedRevision === null || failedAcceptance || verificationError !== null ? t('work.acceptance.unreviewed') : t('work.acceptance.stale')
  const currentReview = active && verified?.current === true && verified.reviewRevision === receipt?.reviewRevision
  const canAccept = currentReview && verified.confirmationBlockedBy.length === 0 && work.availability === 'ready'
    // `receipt` is nullable here; the chain's `undefined` is the intended falsy for "no acceptance".
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    && receipt?.reviewable && work.execution === 'idle' && work.approvals === 0 && work.questions === 0
  const blockedBy = !active || work.availability !== 'ready' ? t('work.confirm.blocked.unavailable')
    : work.approvals > 0 ? t('work.confirm.blocked.approval')
      : work.questions > 0 ? t('work.confirm.blocked.question')
        : work.execution !== 'idle' ? t('work.confirm.blocked.running')
          : checking ? t('work.acceptance.checking')
            : !currentReview ? t('work.confirm.blocked.unverified')
              : verified.confirmationBlockedBy.map(reason => t(`work.confirm.blocked.${reason}`)).join(' · ')
  const openCurrentConversation = (): void => { if (work.sessionId !== undefined) openConversation(work.sessionId) }
  return <section className={css.page} data-work-page>
    <header className={css.pageHeading}>
      <div><p className={css.eyebrow}>{t('work.title')}</p><h2>{work.goal?.objective || t('work.session.title')}</h2>
        <p className={css.scope}>{t('work.scope', { workspace: work.cwd ?? t('work.noWorkspace'), session: work.sessionId })}</p>
      </div>
      <button type="button" className={css.filesButton} onClick={openCurrentConversation}>{t('work.openConversation')}</button>
    </header>
    <div className={css.statusStrip} aria-label={t('work.status')}>
      <span>{t('work.execution')}: <strong>{execution}</strong></span><span>{t('work.goal.phase')}: <strong>{goalPhase}</strong></span>
      <span>{t('work.plan')}: {plan}</span><span>{t('work.availability')}: <strong>{t(`work.availability.${work.availability}`)}</strong></span>
    </div>
    {work.availability !== 'ready' ? <p role="status" className={css.attention}>{t('work.staleFacts')}</p> : null}
    {work.availability === 'ready' && (work.approvals > 0 || work.questions > 0) ? <section className={css.attention} aria-label={t('work.attention.title')}>
      <h3>{t('work.attention.title')}</h3><p role="status">{t('work.attention', { approvals: work.approvals, questions: work.questions })}</p>
      <p>{t('work.attention.description')}</p>
      <button type="button" className={css.filesButton} onClick={openCurrentConversation}>{t('work.attention.resolve')}</button>
    </section> : null}
    <div className={css.workGrid}>
      {renderSlot('work.activity', {})}
      <section className={css.card} aria-label={t('work.results.title')}>
        <h3>{t('work.results.title')}</h3><p>{t('work.results.description')}</p>
        {work.jobs.failed > 0 || work.jobs.killed > 0 ? <p role="status">{t('work.jobOutcomes', { failed: work.jobs.failed, killed: work.jobs.killed })}</p> : null}
        {work.unindexedResults === null ? <p>{t('work.inventoryUnavailable')}</p>
          : work.unindexedResults > 0 ? <p>{t('work.inventoryIncomplete', { count: work.unindexedResults })}</p> : null}
        {work.deliverables.length === 0 ? <p>{t('work.results.empty')}</p> : <ul className={css.deliverables}>{work.deliverables.map(path => <li key={path}>
          <button type="button" title={path} disabled={!active || work.availability !== 'ready' || (opening !== null && opening.sessionId === work.sessionId && opening.path === path)} onClick={() => { open(path) }}>{path}</button>
        </li>)}</ul>}
        <button type="button" className={css.filesButton} disabled={!active || work.cwd === undefined || work.availability !== 'ready'} title={work.cwd} onClick={openFiles}>{t('work.files')}</button>
      </section>
    </div>
    <section className={css.card} aria-label={t('work.confirm.title')}>
      <div className={css.pageHeading}><div><h3>{t('work.confirm.title')}</h3><p>{t('work.acceptance.description')}</p></div>
        <span className={css.badge}>{acceptanceLabel}</span>
      </div>
      {receipt !== null ? <p>{t('work.confirm.revision', { revision: receipt.reviewRevision })}</p> : null}
      {contentState !== undefined ? <p>{t('work.contentReview')}: <span className={css.badge}>{t(`work.contentReview.${contentState}`)}</span></p> : null}
      {canAccept && !accepted && !accepting && !checking ? <p role="status">{t('work.reviewReady')}</p> : null}
      {blockedBy !== '' ? <p id={blockerId} role="status">{blockedBy}</p> : null}
      <div className={css.actions}>
        <button type="button" className={css.filesButton} aria-describedby={blockedBy === '' ? undefined : blockerId} disabled={!canAccept || accepting || accepted} onClick={accept}>{accepting ? t('work.acceptance.saving') : t('work.acceptance.confirm')}</button>
        <button type="button" className={css.filesButton} disabled={!active || work.availability !== 'ready' || work.execution !== 'idle' || checking || accepting} onClick={() => { setRefresh(value => value + 1) }}>{t('work.confirm.refresh')}</button>
      </div>
      {verificationError !== null ? <p role="alert">{t('work.acceptance.checkFailed', { message: verificationError })}</p> : null}
      {failedAcceptance ? <p role="alert">{t('work.acceptance.failed', { message: acceptanceError.message })}</p> : null}
    </section>
    {failure !== null && failure.sessionId === work.sessionId ? <div role="alert" className={css.openError}>
      <p>{t('work.openFailed', { message: failure.message })}</p>
      <button type="button" onClick={() => { open(failure.path) }}>{t('work.retry')}</button>
      <button type="button" onClick={() => { request.current += 1; setFailure(null); setOpening(null) }}>{t('work.dismiss')}</button>
    </div> : null}
  </section>
}
