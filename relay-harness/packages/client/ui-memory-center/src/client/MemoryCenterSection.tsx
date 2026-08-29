/** Governed long-term-memory catalog and editor. */
import { useEffect, useRef, useState } from 'react'
import type {
  MemoryCenterDetail,
  MemoryCenterListRequest,
  MemoryCenterSnapshot,
} from '@relay-harness/rlh-api-remotes/client'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'
import {
  Button,
  IconRefreshOutline16,
  IconSearchOutline16,
  Input,
  Modal,
  Pill,
} from '@relay-harness/rlh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { MemoryCenterLocaleKey } from './locales.ts'
import styles from './MemoryCenterSection.module.css'

type StatusFilter = 'all' | 'active' | 'candidate' | 'disputed' | 'superseded' | 'tombstoned'

interface ReviseInput {
  content: string
  summary: string | null
  importance: number
  confidence: number
  validUntil: number | null
}

/** Remote/cache methods injected into the Settings slot. */
export interface MemoryCenterSectionInjected {
  list: (request: MemoryCenterListRequest, fresh?: boolean) => Promise<MemoryCenterSnapshot>
  read: (request: { workspaceId: string; sessionId: string; id: string }, fresh?: boolean) => Promise<MemoryCenterDetail>
  approve: (sessionId: string, id: string, expectedRevision: number) => Promise<MemoryCenterDetail>
  reject: (sessionId: string, id: string, expectedRevision: number, reason: string) => Promise<MemoryCenterDetail>
  revise: (sessionId: string, id: string, expectedRevision: number, input: ReviseInput) => Promise<MemoryCenterDetail>
  tombstone: (sessionId: string, id: string, expectedRevision: number, reason: string) => Promise<MemoryCenterDetail>
  t: (key: MemoryCenterLocaleKey) => string
}

export type MemoryCenterSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.memory'>
  & InjectFace<MemoryCenterSectionInjected>

type View =
  | { status: 'loading' }
  | { status: 'no-session' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: MemoryCenterSnapshot }

interface EditorDraft {
  content: string
  summary: string
  importance: string
  confidence: string
  validUntil: string
}

/** Render the Memory Center settings page. */
export function MemoryCenterSection(props: MemoryCenterSectionProps) {
  const t = props.t
  const sessionId = props.useSessions(sessions => sessions.current)
  const cwd = props.useSessions((sessions) => {
    const current = sessions.current
    return current === undefined ? undefined : sessions.byId[current]?.cwd
  })
  const workspaceId = cwd?.trim() || 'global'
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [view, setView] = useState<View>({ status: 'loading' })
  const [detail, setDetail] = useState<MemoryCenterDetail | undefined>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [editor, setEditor] = useState<EditorDraft | undefined>()
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [mutationError, setMutationError] = useState<string | undefined>()
  const sequence = useRef(0)
  const scopeGeneration = useRef(0)

  const request = (offset = 0): MemoryCenterListRequest => ({
    workspaceId,
    sessionId: sessionId as SessionId,
    ...query.trim() === '' ? {} : { query: query.trim() },
    ...status === 'all' ? {} : { statuses: [status] },
    includeExpired: true,
    offset,
    limit: 50,
  })

  const load = (fresh: boolean, append = false): void => {
    if (sessionId === undefined) {
      sequence.current += 1
      setView({ status: 'no-session' })
      return
    }
    const current = sequence.current + 1
    sequence.current = current
    if (!append) setView({ status: 'loading' })
    const offset = append && view.status === 'ready' ? view.snapshot.entries.length : 0
    void props.list(request(offset), fresh)
      .then((snapshot) => {
        if (sequence.current !== current) return
        setView(previous => append && previous.status === 'ready'
          ? { status: 'ready', snapshot: { ...snapshot, entries: [...previous.snapshot.entries, ...snapshot.entries] } }
          : { status: 'ready', snapshot })
      })
      .catch(() => {
        if (sequence.current === current && !append) setView({ status: 'error' })
      })
  }

  useEffect(() => {
    scopeGeneration.current += 1
    setDetail(undefined)
    setEditor(undefined)
    setReason('')
    setPending(false)
    setMutationError(undefined)
    if (sessionId === undefined) setView({ status: 'no-session' })
    else load(false)
    return () => { sequence.current += 1; scopeGeneration.current += 1 }
  }, [workspaceId, sessionId, query, status, props.list])

  const openDetail = (id: string): void => {
    if (sessionId === undefined) return
    const generation = scopeGeneration.current
    setDetailLoading(true)
    setMutationError(undefined)
    void props.read({ workspaceId, sessionId, id }, true)
      .then((loaded) => { if (scopeGeneration.current === generation) { setDetail(loaded); setReason('') } })
      .catch(() => { if (scopeGeneration.current === generation) setMutationError(t('error')) })
      .finally(() => { if (scopeGeneration.current === generation) setDetailLoading(false) })
  }

  const mutate = (label: MemoryCenterLocaleKey, action: () => Promise<MemoryCenterDetail>): void => {
    if (pending) return
    const generation = scopeGeneration.current
    setPending(true)
    setMutationError(undefined)
    void action()
      .then((updated) => {
        if (scopeGeneration.current !== generation) return
        setDetail(updated)
        setEditor(undefined)
        setReason('')
        load(true)
      })
      .catch((error: unknown) => { if (scopeGeneration.current === generation) setMutationError(messageOf(error, t(label))) })
      .finally(() => { if (scopeGeneration.current === generation) setPending(false) })
  }

  return (
    <div className={styles.section}>
      <div className={styles.heading}>
        <div>
          <h2 className={styles.title}>{t('title')}</h2>
          <p className={styles.intro}>{t('intro')}</p>
          <p className={styles.scope}>{format(t('scope'), { workspace: workspaceId })}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          icon={<IconRefreshOutline16 />}
          aria-label={t('refresh')}
          onClick={() => { load(true) }}
        />
      </div>
      {sessionId === undefined ? <p className={styles.notice}>{t('noSession')}</p> : null}

      <div className={styles.filters}>
        <Input
          type="search"
          value={query}
          icon={<IconSearchOutline16 />}
          aria-label={t('search')}
          placeholder={t('search')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <select
          className={styles.select}
          aria-label={t('status')}
          value={status}
          onChange={(event) => { setStatus(event.target.value as StatusFilter) }}
        >
          {(['allStatuses', 'active', 'candidate', 'disputed', 'superseded', 'tombstoned'] as const).map((key, index) => (
            <option key={key} value={index === 0 ? 'all' : key}>{t(key)}</option>
          ))}
        </select>
      </div>

      {view.status === 'loading' ? <p role="status" className={styles.notice}>{t('loading')}</p> : null}
      {view.status === 'error' ? (
        <div className={styles.notice} role="alert">
          <p>{t('error')}</p>
          <Button variant="outline" onClick={() => { load(true) }}>{t('retry')}</Button>
        </div>
      ) : null}
      {view.status === 'ready' ? (
        <>
          <p className={styles.count}>{format(t('count'), { count: String(view.snapshot.total) })}</p>
          {view.snapshot.total === 0
            ? <p className={styles.notice}>{query.trim() === '' && status === 'all' ? t('empty') : t('noResults')}</p>
            : (
              <ul className={styles.rows}>
                {view.snapshot.entries.map(item => (
                  <li key={item.entry.id} className={styles.row}>
                    <button type="button" className={styles.rowButton} onClick={() => { openDetail(item.entry.id) }}>
                      <span className={styles.rowTop}>
                        <span className={styles.pills}>
                          <Pill>{t(item.entry.status)}</Pill>
                          <Pill>{item.entry.kind}</Pill>
                          <Pill>{t(item.freshness)}</Pill>
                        </span>
                        <span className={styles.date}>{formatDate(item.entry.updatedAt)}</span>
                      </span>
                      <strong className={styles.content}>{item.entry.content}</strong>
                      {item.entry.summary === undefined ? null : <span className={styles.summary}>{item.entry.summary}</span>}
                      <span className={styles.meta}>
                        {t('trust')}: {item.entry.trust} · {t('importance')}: {item.entry.importance} · {t('confidence')}: {Math.round(item.entry.confidence * 100)}%
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          {view.snapshot.hasMore ? (
            <Button variant="outline" onClick={() => { load(false, true) }}>{t('loadMore')}</Button>
          ) : null}
        </>
      ) : null}

      <Modal
        open={detail !== undefined || detailLoading}
        onClose={() => { if (!pending) { setDetail(undefined); setEditor(undefined); setMutationError(undefined) } }}
        title={t('details')}
        closeLabel={t('close')}
        {...styles.modalContent === undefined ? {} : { contentClassName: styles.modalContent }}
        footer={detail === undefined ? undefined : (
          <>
            <Button disabled={pending} onClick={() => { setDetail(undefined); setEditor(undefined) }}>{t('close')}</Button>
            {editor === undefined && detail.memory.entry.status !== 'tombstoned' && detail.memory.entry.status !== 'superseded' ? (
              <Button disabled={pending || sessionId === undefined} onClick={() => { setEditor(draftOf(detail)); setMutationError(undefined) }}>{t('edit')}</Button>
            ) : null}
          </>
        )}
      >
        {detailLoading && detail === undefined ? <p role="status">{t('loading')}</p> : null}
        {detail === undefined ? null : editor === undefined ? (
          <MemoryDetail
            detail={detail}
            sessionId={sessionId}
            reason={reason}
            pending={pending}
            t={t}
            setReason={setReason}
            approve={() => {
              if (sessionId !== undefined) mutate('approveFailed', () => props.approve(sessionId, detail.memory.entry.id, detail.memory.entry.revision))
            }}
            reject={() => {
              if (sessionId !== undefined) mutate('rejectFailed', () => props.reject(sessionId, detail.memory.entry.id, detail.memory.entry.revision, reason))
            }}
            tombstone={() => {
              if (sessionId !== undefined) mutate('deleteFailed', () => props.tombstone(sessionId, detail.memory.entry.id, detail.memory.entry.revision, reason))
            }}
          />
        ) : (
          <MemoryEditor
            draft={editor}
            pending={pending}
            t={t}
            setDraft={setEditor}
            cancel={() => { setEditor(undefined); setMutationError(undefined) }}
            save={() => {
              if (sessionId === undefined) return
              const parsed = parseDraft(editor)
              if (parsed !== undefined) mutate('reviseFailed', () => props.revise(sessionId, detail.memory.entry.id, detail.memory.entry.revision, parsed))
            }}
          />
        )}
        {mutationError === undefined ? null : <p className={styles.error} role="alert">{mutationError}</p>}
      </Modal>
    </div>
  )
}

function MemoryDetail(props: {
  detail: MemoryCenterDetail
  sessionId: SessionId | undefined
  reason: string
  pending: boolean
  t: MemoryCenterSectionInjected['t']
  setReason: (value: string) => void
  approve: () => void
  reject: () => void
  tombstone: () => void
}) {
  const { entry } = props.detail.memory
  const governance = entry.status === 'candidate' || entry.status === 'disputed'
  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <Pill>{props.t(entry.status)}</Pill><Pill>{entry.kind}</Pill><Pill>{props.t(props.detail.memory.freshness)}</Pill>
      </div>
      <p className={styles.detailContent}>{entry.content}</p>
      {entry.summary === undefined ? null : <p>{entry.summary}</p>}
      <dl className={styles.definition}>
        <dt>{props.t('trust')}</dt><dd>{entry.trust}</dd>
        <dt>{props.t('importance')}</dt><dd>{entry.importance}</dd>
        <dt>{props.t('confidence')}</dt><dd>{Math.round(entry.confidence * 100)}%</dd>
        <dt>{props.t('validUntil')}</dt><dd>{entry.validUntil === undefined ? props.t('noExpiry') : formatDate(entry.validUntil)}</dd>
        <dt>{props.t('updated')}</dt><dd>{formatDate(entry.updatedAt)}</dd>
      </dl>

      <section><h3>{props.t('evidence')}</h3>
        {entry.evidence.length === 0 ? <p>{props.t('noEvidence')}</p> : (
          <ul className={styles.evidenceList}>{entry.evidence.map((evidence, index) => (
            <li key={`${evidence.sessionId}-${index}`}>
              <strong>{format(props.t('sourceSession'), { sessionId: evidence.sessionId, seqs: evidence.eventSeqs.join(', ') })}</strong>
              <span>{evidence.verification}{evidence.callId === undefined ? '' : ` · ${evidence.callId}`}</span>
              {evidence.excerpt === undefined ? null : <blockquote><strong>{props.t('excerpt')}:</strong> {evidence.excerpt}</blockquote>}
            </li>
          ))}</ul>
        )}
      </section>

      <section><h3>{props.t('whyUsed')}</h3>
        <p className={styles.hint}>
          {props.detail.usageCoverage.status === 'complete'
            ? props.t('usageAttached')
            : props.detail.usageCoverage.status === 'partial'
              ? format(props.t('usagePartial'), {
                scanned: String(props.detail.usageCoverage.sessionsScanned),
                failed: String(props.detail.usageCoverage.sessionsFailed),
              })
              : props.t('usageUnavailable')}
        </p>
        {props.detail.memory.whyUsed.length === 0
          ? <p>{props.detail.usageCoverage.status === 'complete' ? props.t('whyUsedEmpty') : props.t('whyUsedUnavailable')}</p>
          : <ul>{props.detail.memory.whyUsed.map(item => <li key={`${item.sessionId}-${item.eventSeq}-${item.evidenceId}`}>{format(props.t('whyUsedItem'), { sessionId: item.sessionId, turn: String(item.turn), step: String(item.step), seq: String(item.eventSeq), revision: item.memoryRevision === undefined ? '?' : String(item.memoryRevision), revisionState: item.revisionState })}</li>)}</ul>}
      </section>

      <section><h3>{props.t('conflicts')}</h3>
        {props.detail.conflicts.length === 0 ? <p>{props.t('noConflicts')}</p> : (
          <ul>{props.detail.conflicts.map(item => <li key={`${item.relation}-${item.entry.entry.id}`}>
            <strong>{conflictLabel(props.t, item.relation)}:</strong> {item.entry.entry.content}
            <span className={styles.hint}> {item.detectorId} · {Math.round(item.score * 100)}% · {item.reasons.join('; ')}</span>
          </li>)}</ul>
        )}
      </section>

      <section><h3>{props.t('signals')}</h3>
        {props.detail.signals.length === 0 ? <p>{props.t('noSignals')}</p> : (
          <ul>{props.detail.signals.map(item => <li key={item.id}>{format(props.t('signalItem'), {
            kind: item.kind,
            sessionId: item.sessionId ?? '—',
            time: formatDate(item.createdAt),
          })}</li>)}</ul>
        )}
      </section>

      <section><h3>{props.t('outcomes')}</h3>
        {props.detail.outcomeCoverage === 'unavailable' ? <p>{props.t('outcomesUnavailable')}</p> : null}
        <p>{format(props.t('outcomeSummary'), {
          positive: String(props.detail.outcomeSummary.positive),
          negative: String(props.detail.outcomeSummary.negative),
          neutral: String(props.detail.outcomeSummary.neutral),
          adjustment: `${props.detail.outcomeSummary.rankingAdjustment >= 0 ? '+' : ''}${(props.detail.outcomeSummary.rankingAdjustment * 100).toFixed(1)}%`,
        })}</p>
        {props.detail.outcomes.length === 0 ? <p>{props.t('noOutcomes')}</p> : (
          <ul>{props.detail.outcomes.map(item => <li key={item.id}>{format(props.t('outcomeItem'), {
            kind: item.kind,
            impact: item.impact,
            sessionId: item.sessionId,
            turn: String(item.turn),
            source: item.sourceRef ?? `events ${item.sourceEventSeqs.join(', ')}`,
          })}</li>)}</ul>
        )}
      </section>

      {entry.status === 'tombstoned' ? null : (
        <div className={styles.governance}>
          {governance ? <Button variant="primary" disabled={props.pending || props.sessionId === undefined} onClick={props.approve}>{props.t('approve')}</Button> : null}
          <Input value={props.reason} disabled={props.pending || props.sessionId === undefined} aria-label={props.t('reason')} placeholder={props.t('reasonPlaceholder')} onChange={(event) => { props.setReason(event.target.value) }} />
          {governance ? <Button disabled={props.pending || props.sessionId === undefined || props.reason.trim() === ''} onClick={props.reject}>{props.t('reject')}</Button> : null}
          <Button disabled={props.pending || props.sessionId === undefined || props.reason.trim() === ''} onClick={props.tombstone}>{props.t('delete')}</Button>
          {props.sessionId === undefined ? <p className={styles.error}>{props.t('mutationRequiresSession')}</p> : null}
        </div>
      )}
    </div>
  )
}

function MemoryEditor(props: {
  draft: EditorDraft
  pending: boolean
  t: MemoryCenterSectionInjected['t']
  setDraft: (value: EditorDraft) => void
  cancel: () => void
  save: () => void
}) {
  const field = (name: keyof EditorDraft, value: string): void => { props.setDraft({ ...props.draft, [name]: value }) }
  return (
    <div className={styles.editor}>
      <label><span>{props.t('content')}</span><textarea value={props.draft.content} disabled={props.pending} onChange={(event) => { field('content', event.target.value) }} /></label>
      <label><span>{props.t('summary')}</span><textarea value={props.draft.summary} disabled={props.pending} onChange={(event) => { field('summary', event.target.value) }} /></label>
      <label><span>{props.t('importance')}</span><input type="number" min="1" max="4" value={props.draft.importance} disabled={props.pending} onChange={(event) => { field('importance', event.target.value) }} /></label>
      <label><span>{props.t('confidence')}</span><input type="number" min="0" max="1" step="0.01" value={props.draft.confidence} disabled={props.pending} onChange={(event) => { field('confidence', event.target.value) }} /></label>
      <label><span>{props.t('validUntilOptional')}</span><input type="datetime-local" value={props.draft.validUntil} disabled={props.pending} onChange={(event) => { field('validUntil', event.target.value) }} /></label>
      <div className={styles.editorActions}><Button disabled={props.pending} onClick={props.cancel}>{props.t('cancel')}</Button><Button variant="primary" disabled={props.pending || props.draft.content.trim() === ''} onClick={props.save}>{props.pending ? props.t('pending') : props.t('save')}</Button></div>
    </div>
  )
}

function draftOf(detail: MemoryCenterDetail): EditorDraft {
  const entry = detail.memory.entry
  return {
    content: entry.content,
    summary: entry.summary ?? '',
    importance: String(entry.importance),
    confidence: String(entry.confidence),
    validUntil: entry.validUntil === undefined ? '' : localDateTime(entry.validUntil),
  }
}

function parseDraft(draft: EditorDraft): ReviseInput | undefined {
  const importance = Number(draft.importance)
  const confidence = Number(draft.confidence)
  const validUntil = draft.validUntil.trim() === '' ? null : new Date(draft.validUntil).getTime()
  if (draft.content.trim() === '' || !Number.isInteger(importance) || importance < 1 || importance > 4) return undefined
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined
  if (validUntil !== null && (!Number.isFinite(validUntil) || validUntil <= Date.now())) return undefined
  return { content: draft.content, summary: draft.summary.trim() === '' ? null : draft.summary, importance, confidence, validUntil }
}

function localDateTime(value: number): string {
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function conflictLabel(
  t: MemoryCenterSectionInjected['t'],
  relation: MemoryCenterDetail['conflicts'][number]['relation'],
): string {
  switch (relation) {
    case 'supersedes': return t('supersedes')
    case 'superseded-by': return t('supersededBy')
    case 'exact-duplicate': return t('exactDuplicate')
    case 'normalized-summary-collision': return t('summaryCollision')
    case 'semantic-conflict': return t('semanticConflict')
  }
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function format(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`)
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}
