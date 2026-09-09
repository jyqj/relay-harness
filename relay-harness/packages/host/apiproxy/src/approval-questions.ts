/**
 * Pending approval and ask-user-question entries: stable server-request ids,
 * answerable mux-frame projection, and answer-batch validation.
 * @module @relay-harness/rlh-host-apiproxy/approval-questions
 */

import type { Agent } from '@relay-harness/rlh-agent'
import type { ApprovalOutcome, ApprovalRequestId } from '@relay-harness/rlh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem, UserQuestionError } from '@relay-harness/rlh-user-questions'
import type { CallId } from '@relay-harness/rlh-llm/brand'
import type { SessionId } from '@relay-harness/rlh-session'
import type { MuxFrame, QuestionResponsePayload, RpcRequest } from './api/index.ts'
import type { RpcId } from './api/rpc.ts'

/**
 * One outstanding approval question: the stable server-request id, the frame
 * material replayed to late mux subscribers, and the resolver that settles the
 * answerer's promise back into `ctx.approval`.
 */
export interface PendingApproval {
  /** Exact runtime owner; a same-id successor does not inherit this wait. */
  owner: Agent
  rpcId: RpcId
  sessionId: SessionId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  reason?: string
  resolve(outcome: ApprovalOutcome): void
}

/**
 * Project a pending entry into its answerable mux frame (initial push and
 * mux-open replay share it).
 * @param pending - the outstanding approval entry to project.
 * @returns the `approval/requested` frame addressed by the entry's stable rpcId.
 */
export function requestedFrame(pending: PendingApproval): RpcRequest<MuxFrame> {
  return {
    rpcId: pending.rpcId,
    payload: {
      type: 'approval/requested',
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      ...pending.callId === undefined ? {} : { callId: pending.callId },
      ...pending.reason === undefined ? {} : { reason: pending.reason },
    },
  }
}

/** One host-owned question wait, addressed by the stable server-request id. */
export interface PendingQuestion {
  /** Exact runtime owner; teardown withdraws the wait even without a request signal. */
  owner: Agent
  rpcId: RpcId
  sessionId: SessionId
  questions: AskUserQuestionItem[]
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: UserQuestionError) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * Validate one answer batch against the exact question request it resolves.
 * @param payload - the answer batch candidate from the answering client.
 * @param pending - the outstanding question request the batch must resolve.
 * @returns whether every answer maps onto its question (ids, option labels,
 * multi-select, and custom-text rules).
 */
export function matchesQuestions(payload: QuestionResponsePayload, pending: PendingQuestion): boolean {
  if (payload.sessionId !== pending.sessionId) return false
  const answers = payload.answer.answers
  if (answers.length !== pending.questions.length) return false
  return answers.every((answer, index) => {
    const question = pending.questions[index] as AskUserQuestionItem
    if (answer.id !== question.id) return false
    if (new Set(answer.selected).size !== answer.selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true) {
      if (custom !== undefined && answer.selected.length > 0) return false
      if (answer.selected.length > 1) return false
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return answer.selected.every(label => labels.has(label))
  })
}
