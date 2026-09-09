/**
 * Official popupSelect shell: renders one session's PopupSelectController
 * store into the conversation.input.overlay anchor. Unlike the slash menu
 * (combobox — textarea keeps focus), this shell HOLDS focus while open: the
 * inner search input takes focus, plain typing filters the loaded options
 * locally, Enter/↑↓ drive the filtered highlight (scrolled into view), Escape
 * dismisses back to the composer, and ←→ keep the search input's native
 * caret. Any pointer interaction outside the box dismisses (the click's own
 * target takes focus). Closed state renders null; the overlay slot stays
 * mounted. The card height clamps to the space above the composer.
 */
import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16, RiskConfirmation, useAnchoredMaxHeight, usePresence } from '@relay-harness/rlh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@relay-harness/rlh-client-ui-slots'
import { filterOptions } from './popup.ts'
import type { PopupSelectController, PopupState } from './popup.ts'
import type { SnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import css from './PopupSelectView.module.css'

/** Design cap on the card height (same MenuDropdown family as the slash menu). */
const MAX_HEIGHT = 320

/** Injected business face of the popupSelect overlay entry. */
export type PopupSelectInjected = Pick<PopupSelectController,
  'dismiss' | 'move' | 'select' | 'setSearch' | 'retry' | 'highlight' | 'acknowledge' | 'cancelConfirmation' | 'confirm'> & {
    hooks: { popup: SnapshotStore<PopupState> }
  }

/** Full shell props: injected face + the locale seat. */
export type PopupSelectViewProps = InjectFace<PopupSelectInjected> & PropsLocale<'command'>

/**
 * Render the popupSelect shell overlay entry.
 * @param props - framework state hook and scoped controller actions; `t` rides the standard locale seat.
 * @returns the select card while open; null while closed.
 */
export function PopupSelectView({
  usePopup, dismiss, move, select, setSearch, retry, highlight, acknowledge, cancelConfirmation, confirm, t,
}: PopupSelectViewProps) {
  const state = usePopup(value => value)
  const cardRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const lastOpen = useRef(state)
  if (state.open) lastOpen.current = state
  const view = state.open ? state : lastOpen.current
  const { mounted, state: motionState } = usePresence(state.open)
  // The card is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update.
  const maxHeight = useAnchoredMaxHeight(cardRef, MAX_HEIGHT, mounted)
  const active = state.open ? state.active : null

  // The search input keeps focus while arrows move a virtual highlight, so
  // the browser never scrolls the active row into view — do it here.
  useEffect(() => {
    if (active === null) return
    cardRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Focus ownership: the search input grabs on open, and ANY outside
  // pointer interaction dismisses —
  // capture phase so a click landing anywhere else (textarea included)
  // closes the shell before its own handlers run; that click's target then
  // takes focus naturally, so no focusComposer here.
  useEffect(() => {
    if (!state.open || state.confirming !== null) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target)) return
      dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, state.confirming, dismiss])

  // Focus the search input after it mounts (separate effect so the ref is populated).
  useEffect(() => {
    if (mounted && state.open && state.confirming === null) searchRef.current?.focus()
  }, [mounted, state.open, state.confirming])

  if (!mounted) return null

  const rows = filterOptions(view.options, view.search)
  const confirmation = view.confirming?.confirmation

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>): void => {
    // ArrowLeft/ArrowRight fall through on purpose: the search input keeps
    // its native caret movement.
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        ev.preventDefault()
        move(-1)
        return
      case 'Enter':
        ev.preventDefault()
        void select(state.active)
        return
      case 'Escape':
        ev.preventDefault()
        dismiss({ focusComposer: true })
        return
      default:
    }
  }

  return (
    <>
      {view.confirming === null && (
        <div
          ref={cardRef}
          className={css.card}
          style={{ maxHeight }}
          data-rlh-motion="popover"
          data-state={motionState}
          aria-hidden={state.open ? undefined : true}
          aria-label={t('overlay.aria', { command: String(view.command) })}
          onKeyDown={onKeyDown}
        >
          <input
            ref={searchRef}
            className={css.search}
            type="text"
            placeholder={t('search.placeholder')}
            aria-label={t('search.aria')}
            value={view.search}
            readOnly={view.submitting}
            onChange={(ev) => { setSearch(ev.currentTarget.value) }}
          />
          {view.error !== null && (
            <div className={css.error} role="alert">
              <span className={css.errorText}>{view.error}</span>
              {view.status === 'failed' && (
                <button type="button" className={css.retry} onClick={() => { retry() }}>{t('retry')}</button>
              )}
            </div>
          )}
          {view.status === 'pending' && <div className={css.status}>{t('status.loading')}</div>}
          {view.submitting && <div className={css.status}>{t('status.applying')}</div>}
          {view.status === 'ready' && rows.length === 0 && <div className={css.status}>{t('status.empty')}</div>}
          {view.status === 'ready' && (
            <div role="listbox" aria-label={t('listbox.aria', { command: String(view.command) })} className={css.viewport}>
              {rows.map((option, index) => (
                <div
                  key={option.id}
                  role="option"
                  aria-selected={index === view.active}
                  className={clsx(css.row, index === view.active && css.rowActive)}
                  // mousedown would race the document capture listener; the shell
                  // owns focus anyway, so a plain click (inside the card → no
                  // dismiss) works.
                  onClick={() => { void select(index) }}
                  onMouseEnter={() => { highlight(index) }}
                >
                  <span className={css.label}>{option.label}</span>
                  {option.detail !== undefined && <span className={css.detail}>{option.detail}</span>}
                  {option.active === true && <span className={css.check}><IconCheckOutline16 /></span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {confirmation !== undefined && (
        <RiskConfirmation
          open
          title={confirmation.title}
          description={confirmation.description}
          acknowledgeLabel={confirmation.acknowledgeLabel}
          cancelLabel={confirmation.cancelLabel}
          confirmLabel={confirmation.confirmLabel}
          acknowledged={view.acknowledged}
          onAcknowledgedChange={(value) => { acknowledge(value) }}
          onCancel={() => { cancelConfirmation() }}
          onConfirm={() => { void confirm() }}
        />
      )}
    </>
  )
}
