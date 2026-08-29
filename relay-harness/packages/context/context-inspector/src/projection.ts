/** Pure fold from durable context/prepared facts into a bounded inspector projection. */

import { z } from 'zod'
import type { JsonValue, SessionEvent } from '@relay-harness/rlh-session/types'
import type { ProjectionDefinition } from '@relay-harness/rlh-session-projection'
import type {
  ContextInspectorContribution,
  ContextInspectorEvidence,
  ContextInspectorLinkedMessage,
  ContextInspectorProjection,
  ContextInspectorTrace,
} from './types.ts'
import type {} from '@relay-harness/rlh-context-engine/types'

const MAX_TRACES = 50
const MAX_MESSAGES = 500
const MAX_PREVIEW = 240

interface State {
  readonly projection: ContextInspectorProjection
  readonly messages: Readonly<Record<string, ContextInspectorLinkedMessage>>
  readonly messageOrder: readonly string[]
}

const schema = z.object({
  traces: z.array(z.unknown()),
  omittedTraces: z.number().int().nonnegative(),
}).strict() as z.ZodType<ContextInspectorProjection>

function previewOf(event: SessionEvent<'user/message'>): string {
  const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').trim()
  return Array.from(text).slice(0, MAX_PREVIEW).join('')
}

function sourceKindOf(event: SessionEvent<'user/message'>): string {
  return typeof event.data.source.kind === 'string' ? event.data.source.kind : 'unknown'
}

function whyUsedOf(domain: JsonValue | undefined, contributorId: string): readonly string[] {
  if (typeof domain === 'object' && domain !== null && !Array.isArray(domain)) {
    const reason = domain['selectionReason'] ?? domain['reasons'] ?? domain['matchedBy']
    if (typeof reason === 'string' && reason.trim() !== '') return [reason]
    if (Array.isArray(reason)) {
      const values = reason.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      if (values.length > 0) return values.slice(0, 8)
    }
  }
  return [`selected by ${contributorId}`]
}

function pathOf(domain: JsonValue | undefined): string | undefined {
  if (typeof domain !== 'object' || domain === null || Array.isArray(domain)) return undefined
  return typeof domain['filePath'] === 'string' ? domain['filePath'] : undefined
}

function contributionOf(
  contribution: SessionEvent<'context/prepared'>['data']['contributions'][number],
  messages: Readonly<Record<string, ContextInspectorLinkedMessage>>,
): ContextInspectorContribution {
  return {
    contributorId: contribution.contributorId,
    messageId: String(contribution.messageId),
    admitted: contribution.messageEventSeqs.length > 0,
    messageEventSeqs: contribution.messageEventSeqs,
    linkedMessages: contribution.messageEventSeqs.flatMap(seq => messages[String(seq)] ?? []),
    evidence: contribution.evidence.map((evidence): ContextInspectorEvidence => {
      const path = pathOf(evidence.domain)
      return {
        ...evidence,
        ...(path === undefined ? {} : { path }),
        whyUsed: whyUsedOf(evidence.domain, contribution.contributorId),
      }
    }),
    ...(contribution.coverage === undefined ? {} : { coverage: contribution.coverage }),
  }
}

/** Whole-log `contextInspector` projection unit. */
export const contextInspectorProjectionDefinition: ProjectionDefinition<'contextInspector', State> = {
  key: 'contextInspector',
  schema,
  stateVersion: 1,
  init: () => ({ projection: { traces: [], omittedTraces: 0 }, messages: {}, messageOrder: [] }),
  apply: (state, event) => {
    if (event.type === 'user/message') {
      const key = String(event.seq)
      const message: ContextInspectorLinkedMessage = {
        seq: event.seq,
        messageId: String(event.data.id),
        sourceKind: sourceKindOf(event),
        preview: previewOf(event),
      }
      const order = [...state.messageOrder, key]
      const messages = { ...state.messages, [key]: message }
      while (order.length > MAX_MESSAGES) {
        const oldest = order.shift()
        if (oldest !== undefined) Reflect.deleteProperty(messages, oldest)
      }
      return { ...state, messages, messageOrder: order }
    }
    if (event.type !== 'context/prepared') return state
    const contributions = event.data.contributions.map(item => contributionOf(item, state.messages))
    const trace: ContextInspectorTrace = {
      seq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      plan: event.data.plan,
      decisions: event.data.decisions,
      contributions,
      admittedContributions: contributions.filter(item => item.admitted).length,
      rejectedContributions: contributions.filter(item => !item.admitted).length,
      retrievalRejections: event.data.decisions.filter(item => item.outcome === 'rejected').length,
      evidenceCount: contributions.reduce((sum, item) => sum + item.evidence.length, 0),
    }
    const traces = [...state.projection.traces, trace]
    const omitted = Math.max(0, traces.length - MAX_TRACES)
    return {
      ...state,
      projection: {
        traces: traces.slice(-MAX_TRACES),
        omittedTraces: state.projection.omittedTraces + omitted,
      },
    }
  },
  view: state => state.projection,
}
