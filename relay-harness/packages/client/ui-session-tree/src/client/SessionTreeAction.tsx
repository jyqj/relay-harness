import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SessionTreeAction.module.css'

/** Per-session action face. */
export interface SessionTreeActionInjected {
  openTree: () => void
}

export type SessionTreeActionProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'sessionTree'>
  & InjectFace<SessionTreeActionInjected>

/** Open the workspace-wide Tree around this Session. */
export function SessionTreeAction({ openTree, t }: SessionTreeActionProps) {
  return (
    <button className={css.button} type="button" onClick={openTree} title={t('open')} aria-label={t('open')}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="4" cy="5" r="2" />
        <circle cx="16" cy="5" r="2" />
        <circle cx="10" cy="15" r="2" />
        <path d="M6 5h4a4 4 0 0 1 4 4v1M14 5h-4a4 4 0 0 0-4 4v1M6 10a4 4 0 0 0 4 4" />
      </svg>
    </button>
  )
}
