/** Prompt Enhancement button occupying the composer's right control row. */

import { useEffect, useRef, useState } from 'react'
import type { PromptEnhancementOutcome, PromptEnhancementResult } from '@relay-harness/rlh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import {
  Button,
  DiffBlock,
  IconEnhanceOutline16,
  Modal,
  Tooltip,
} from '@relay-harness/rlh-client-ui-primitives'
import type {} from '@relay-harness/rlh-client-ui-conversation/client'
import type { PromptEnhancementInjected } from './index.ts'
import css from './EnhanceControl.module.css'

/** Full slot props: InputZone owner share, injected actions, and locale. */
export type EnhanceControlProps =
  PropsRuntime<'conversation.input.right'>
  & InjectFace<PromptEnhancementInjected>
  & PropsLocale<'promptEnhancement'>

/**
 * Run one cancellable enhancement and replace the draft only when both its
 * value and monotonic revision still match the attempt. Replacement is one
 * input transaction; the ordinary composer undo and this control's explicit
 * compare-before-undo action both restore the original draft.
 */
export function EnhanceControl({ session, input, inputActions, enhance, t }: EnhanceControlProps) {
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [proposal, setProposal] = useState<{
    readonly result: PromptEnhancementResult
    readonly draftRev: number
  } | null>(null)
  const [notice, setNotice] = useState<{ level: 'info' | 'error'; text: string } | null>(null)
  const [undo, setUndo] = useState<{
    readonly originalDraft: string
    readonly enhancedDraft: string
    readonly enhancedDraftRev: number
  } | null>(null)
  const operation = useRef<AbortController | null>(null)

  useEffect(() => {
    operation.current?.abort(new Error('Prompt Enhancement session changed'))
    operation.current = null
    setBusy(false)
    setCancelling(false)
    setProposal(null)
    setNotice(null)
    setUndo(null)
    return () => {
      operation.current?.abort(new Error('Prompt Enhancement control unmounted'))
      operation.current = null
    }
  }, [session.sessionId, session.removed])

  const run = (): void => {
    if (operation.current !== null || input.phase !== 'plain' || input.draft.trim().length === 0 || session.removed) return
    const originalDraft = input.draft
    const originalDraftRev = input.draftRev
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setCancelling(false)
    setNotice(null)
    setUndo(null)
    void enhance(originalDraft, controller.signal).then((outcome: PromptEnhancementOutcome) => {
      if (controller.signal.aborted || operation.current !== controller) return
      if (outcome.kind === 'enhanced') {
        if (outcome.result.originalDraft !== originalDraft) {
          setNotice({ level: 'error', text: t('result.mismatch') })
          return
        }
        setProposal({ result: outcome.result, draftRev: originalDraftRev })
      } else if (outcome.reason === 'failed') {
        setNotice({ level: 'error', text: outcome.failure?.message ?? 'Prompt Enhancement failed' })
      }
    }, (error: unknown) => {
      if (!controller.signal.aborted) {
        setNotice({ level: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    }).finally(() => {
      if (operation.current !== controller) return
      operation.current = null
      setBusy(false)
      setCancelling(false)
    })
  }

  const cancelRunning = (): void => {
    const controller = operation.current
    if (controller === null || controller.signal.aborted) return
    controller.abort(new Error('Prompt Enhancement cancelled by user'))
    setCancelling(true)
  }
  const disabled = cancelling
    || (!busy && (input.phase !== 'plain' || input.draft.trim().length === 0 || session.removed))
  const label = t(cancelling ? 'button.cancelling' : busy ? 'button.cancel' : 'button.label')
  const closeProposal = (): void => { setProposal(null) }
  const acceptProposal = (): void => {
    if (proposal === null) return
    if (input.draft !== proposal.result.originalDraft || input.draftRev !== proposal.draftRev) {
      setNotice({ level: 'info', text: t('draft.changed') })
    } else {
      inputActions.setDraft(proposal.result.enhancedDraft)
      if (proposal.result.enhancedDraft !== proposal.result.originalDraft) {
        setUndo({
          originalDraft: proposal.result.originalDraft,
          enhancedDraft: proposal.result.enhancedDraft,
          enhancedDraftRev: proposal.draftRev + 1,
        })
        setNotice({ level: 'info', text: t('proposal.applied') })
      }
    }
    setProposal(null)
  }
  const undoAccepted = (): void => {
    if (undo === null) return
    if (input.draft !== undo.enhancedDraft || input.draftRev !== undo.enhancedDraftRev) {
      setNotice({ level: 'info', text: t('draft.changed') })
    } else {
      inputActions.setDraft(undo.originalDraft)
      setNotice({ level: 'info', text: t('proposal.undone') })
    }
    setUndo(null)
  }
  return (
    <>
      <Tooltip label={label} side="top" delayMs={500}>
        <button
          type="button"
          className={css.button}
          aria-label={label}
          aria-busy={busy || undefined}
          disabled={disabled}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={busy ? cancelRunning : run}
        >
          <IconEnhanceOutline16 size={15} />
        </button>
      </Tooltip>
      <Modal
        open={proposal !== null}
        onClose={closeProposal}
        title={t('proposal.title')}
        closeLabel={t('proposal.close')}
        description={t('proposal.description')}
        className={css.dialog}
        contentClassName={css['content'] ?? ''}
        footer={(
          <>
            <Button variant="ghost" autoFocus onClick={closeProposal}>{t('proposal.cancel')}</Button>
            <Button variant="primary" onClick={acceptProposal}>{t('proposal.accept')}</Button>
          </>
        )}
      >
        {proposal !== null && (
          <div className={css.proposal}>
            <DiffBlock diffs={[{
              path: 'Prompt',
              oldText: proposal.result.originalDraft,
              newText: proposal.result.enhancedDraft,
            }]} maxLines={24} />
            {proposal.result.assumptions.length > 0 && (
              <section>
                <h3>{t('proposal.assumptions')}</h3>
                <ul>{proposal.result.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
            )}
            {proposal.result.openQuestions.length > 0 && (
              <section>
                <h3>{t('proposal.questions')}</h3>
                <ul>{proposal.result.openQuestions.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
            )}
          </div>
        )}
      </Modal>
      {notice !== null && (
        <span className={css.noticeRow}>
          <span className={css.notice} data-level={notice.level} role="status" title={notice.text}>
            {notice.text}
          </span>
          {undo !== null && (
            <Button variant="toolbar" size="sm" onClick={undoAccepted}>{t('proposal.undo')}</Button>
          )}
        </span>
      )}
    </>
  )
}
