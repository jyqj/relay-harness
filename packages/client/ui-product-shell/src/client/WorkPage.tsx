import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type {} from '@relay-harness/rlh-client-ui-sidebar/client'
import type { WorkSummary } from './work-projection.ts'
import type { ProductShellKey } from './locales.ts'
import css from './ProductShell.module.css'

export interface WorkPageInjected {
  hooks: { work: { getSnapshot(): WorkSummary; subscribe(listener: () => void): () => void } }
  openDeliverable: (path: string) => Promise<void>
  openFiles: () => void
}
export type WorkPageProps = PropsRuntime<'sidebar.page'> & PropsLocale<'productShell'> & InjectFace<WorkPageInjected>

/** Render a compact composition of the current Session's existing projections. */
export function WorkPage({ wide, useWork, openDeliverable, openFiles, t }: WorkPageProps) {
  const work = useWork(value => value)
  if (!wide) return <div className={css.railMark} aria-label={t('nav.work')}>W</div>
  if (work.sessionId === undefined) return <section className={css.page}><h2>{t('work.title')}</h2><p>{t('work.empty')}</p></section>
  const plan = work.plan?.pending ? t('work.plan.pending') : work.plan?.active ? t('work.plan.on') : t('work.plan.off')
  const completion = work.completion === 'complete'
    ? t('work.completion.complete')
    : work.completion === 'running'
      ? t('work.completion.running')
      : t('work.completion.idle')
  const rows: readonly [ProductShellKey, string][] = [
    ['work.goal', work.goal === null ? t('work.goal.empty') : work.goal.objective],
    ['work.plan', plan],
    ['work.jobs', `${work.jobs.running}/${work.jobs.total}`],
    ['work.trajectory', String(work.trajectoryRecords)],
    ['work.deliverables', String(work.deliverables.length)],
    ['work.approvals', String(work.approvals)],
    ['work.questions', String(work.questions)],
    ['work.completion', completion],
  ]
  return <section className={css.page}>
    <h2>{t('work.title')}</h2>
    <dl className={css.metrics}>{rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
    <button type="button" className={css.filesButton} disabled={work.cwd === undefined} title={work.cwd} onClick={openFiles}>{t('work.files')}</button>
    {work.deliverables.length > 0 ? <ul className={css.deliverables}>{work.deliverables.map(path => <li key={path}><button type="button" title={path} onClick={() => { void openDeliverable(path) }}>{path}</button></li>)}</ul> : null}
  </section>
}
