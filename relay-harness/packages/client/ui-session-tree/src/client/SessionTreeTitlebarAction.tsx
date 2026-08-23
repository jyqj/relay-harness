import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import css from './SessionTreeAction.module.css'

/** Root titlebar action face. */
export interface SessionTreeTitlebarActionInjected {
  openTree: (sessionId: SessionId) => void
}

export type SessionTreeTitlebarActionProps =
  & PropsRuntime<'shell.titlebar.trailing'>
  & PropsLocale<'sessionTree'>
  & InjectFace<SessionTreeTitlebarActionInjected>

/** Open the Tree from shared chrome while a current Session exists. */
export function SessionTreeTitlebarAction({ useSessions, openTree, t }: SessionTreeTitlebarActionProps) {
  const current = useSessions(state => state.current)
  return (
    <button
      className={css.button}
      type="button"
      disabled={current === undefined}
      onClick={() => { if (current !== undefined) openTree(current) }}
      title={t('titlebarOpen')}
      aria-label={t('titlebarOpen')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="4" cy="5" r="2" />
        <circle cx="16" cy="5" r="2" />
        <circle cx="10" cy="15" r="2" />
        <path d="M6 5h4a4 4 0 0 1 4 4v1M14 5h-4a4 4 0 0 0-4 4v1M6 10a4 4 0 0 0 4 4" />
      </svg>
    </button>
  )
}
