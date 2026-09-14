/** Live execution relationships projected from the existing Session list and child catalog. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'
import css from './ProductShell.module.css'

/** Addressed navigation only; execution controls are not fabricated for unsupported providers. */
export interface WorkActivityInjected { openConversation: (sessionId: SessionId) => void }
export type WorkActivityProps = PropsRuntime<'work.activity'> & PropsLocale<'productShell'> & InjectFace<WorkActivityInjected>

/** Display direct children and owned background jobs without treating inactivity as success.
 * @param props - Session list hooks, addressed navigation, and copy.
 * @returns Execution relationships with explicit source and state.
 */
export function WorkActivity({ useSessions, openConversation, t }: WorkActivityProps) {
  const state = useSessions(value => value)
  const id = state.current
  if (id === undefined) return null
  const current = state.byId[id]
  const catalog = state.subagentsByParent[id]
  const children = catalog === undefined
    ? Object.values(state.byId).filter(child => child.parentId === id).map(child => ({ id: child.id, label: child.displayTitle, running: child.running }))
    : catalog.entries.filter(entry => entry.kind === 'child').map(entry => ({
      id: entry.id,
      label: ('label' in entry ? entry.label : undefined) || state.byId[entry.id]?.displayTitle || String(entry.id),
      running: entry.activity === 'running',
    }))
  const jobs = state.jobsBySession[id] ?? []
  return <section className={css.card} aria-label={t('work.activity.title')}>
    <h3>{t('work.activity.title')}</h3>
    <p>{t('work.activity.scope')}</p>
    {current?.parentId !== undefined ? <button type="button" className={css.filesButton}
      onClick={() => { if (current.parentId !== undefined) openConversation(current.parentId) }}>{t('work.activity.parent')}</button> : null}
    {children.length === 0 && jobs.length === 0 ? <p>{t('work.activity.empty')}</p> : null}
    <ul className={css.activityList}>
      {children.map(child => <li key={child.id}>
        <button type="button" onClick={() => { openConversation(child.id) }}>{child.label}</button>
        <span>{t(state.byId[child.id]?.pendingInteraction !== undefined ? 'work.activity.waiting' : child.running ? 'work.activity.running' : 'work.activity.inactive')}</span>
      </li>)}
      {jobs.map(job => <li key={job.id}>
        <div><strong>{job.label}</strong>{job.detail === undefined ? null : <p>{job.detail}</p>}</div>
        <span>{t(`work.job.${job.status}`)}</span>
      </li>)}
    </ul>
  </section>
}
