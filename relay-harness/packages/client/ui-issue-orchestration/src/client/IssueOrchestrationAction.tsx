import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IssueDashboardState } from './state.ts'
import css from './IssueOrchestrationAction.module.css'

export interface IssueOrchestrationActionInjected {
  hooks: { issueDashboard: SnapshotStore<IssueDashboardState> }
  openDashboard: () => void
}

export type IssueOrchestrationActionProps =
  & PropsRuntime<'shell.titlebar.trailing'>
  & PropsLocale<'issueOrchestration'>
  & InjectFace<IssueOrchestrationActionInjected>

export function IssueOrchestrationAction({ useIssueDashboard, openDashboard, t }: IssueOrchestrationActionProps) {
  const state = useIssueDashboard(value => value)
  const count = state.snapshot === undefined
    ? 0
    : state.snapshot.running.length + state.snapshot.retrying.length + state.snapshot.blocked.length
  return (
    <button className={css.button} type="button" onClick={openDashboard} title={t('open')} aria-label={t('open')}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 4h12v12H4zM7 7h6M7 10h6M7 13h3" />
      </svg>
      {count > 0 ? <span className={css.badge}>{count > 99 ? '99+' : count}</span> : null}
    </button>
  )
}
