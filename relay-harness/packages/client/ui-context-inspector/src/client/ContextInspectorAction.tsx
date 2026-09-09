import { useState } from 'react'
import { Button, Modal, Pill } from '@relay-harness/rlh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import styles from './ContextInspectorAction.module.css'

export type ContextInspectorActionProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'contextInspector'>

function format(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/gu, (_, key: string) => String(values[key] ?? ''))
}

export function ContextInspectorAction({ useProjection, t }: ContextInspectorActionProps) {
  const projection = useProjection('contextInspector')
  const [open, setOpen] = useState(false)
  const count = projection?.traces.length ?? 0
  return (
    <>
      <button className={styles.button} type="button" onClick={() => { setOpen(true) }} aria-label={t('open')} title={t('open')}>
        {format(t('badge'), { count })}
      </button>
      <Modal open={open} onClose={() => { setOpen(false) }} title={t('title')} closeLabel={t('close')}
        footer={<Button onClick={() => { setOpen(false) }}>{t('close')}</Button>}>
        <div className={styles.panel}>
          {projection === undefined || projection.traces.length === 0 ? <p className={styles.empty}>{t('empty')}</p> : null}
          {(projection?.omittedTraces ?? 0) > 0 && projection !== undefined
            ? <p className={styles.muted}>{format(t('omitted'), { count: projection.omittedTraces })}</p>
            : null}
          {[...(projection?.traces ?? [])].reverse().map(trace => (
            <section className={styles.trace} key={trace.seq} data-context-trace={trace.seq}>
              <div className={styles.traceHead}><strong>{format(t('step'), { turn: trace.turn, step: trace.step })}</strong><span className={styles.muted}>{format(t('tracePrepared'), { seq: trace.seq })}</span></div>
              <p className={styles.muted}>{format(t('summary'), { contributors: trace.contributions.length, evidence: trace.evidenceCount, rejected: trace.rejectedContributions })}</p>
              {trace.contributions.map(contribution => (
                <article className={styles.contribution} key={`${trace.seq}:${contribution.contributorId}`}>
                  <div className={styles.pills}><Pill>{contribution.contributorId}</Pill><Pill>{contribution.admitted ? t('admitted') : t('rejected')}</Pill></div>
                  <h4>{t('linked')}</h4>
                  {contribution.linkedMessages.length === 0 ? <p className={styles.muted}>{t('noLink')}</p> : <ul className={styles.list}>{contribution.linkedMessages.map(message => <li key={message.seq}>#{message.seq} · {message.sourceKind} · {message.preview}</li>)}</ul>}
                  <h4>{t('evidence')}</h4>
                  {contribution.evidence.length === 0 ? <p className={styles.muted}>{t('noEvidence')}</p> : contribution.evidence.map(evidence => (
                    <div className={styles.evidence} key={String(evidence.evidenceId)}>
                      <div className={styles.pills}>
                        <Pill>{String(evidence.resource.sourceId)}</Pill>
                        <Pill>{evidence.freshness}</Pill>
                        <Pill>{evidence.verification}</Pill>
                        {evidence.truncated ? <Pill>{t('truncated')}</Pill> : null}
                      </div>
                      <div className={styles.code}>{evidence.path ?? evidence.resource.key}{evidence.resource.revision === undefined ? '' : ` @ ${evidence.resource.revision}`}</div>
                      <p className={styles.why}><strong>{t('why')}:</strong> {evidence.whyUsed.join(' · ')}</p>
                    </div>
                  ))}
                  {contribution.coverage === undefined ? null : <div><h4>{t('coverage')} · {contribution.coverage.completeness}</h4><div><strong>{t('searched')}:</strong> {contribution.coverage.searched.join(', ') || '—'}</div><div><strong>{t('notSearched')}:</strong> {contribution.coverage.notSearched.join(', ') || '—'}</div>{contribution.coverage.rationale === undefined ? null : <p>{contribution.coverage.rationale}</p>}</div>}
                </article>
              ))}
            </section>
          ))}
        </div>
      </Modal>
    </>
  )
}
