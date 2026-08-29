/** Shared Context Engine adapter for Prompt Enhancement. */

import type { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { snapshotJsonValue, type JsonValue } from '@relay-harness/rlh-session'
import type {
  PreparedStepContext,
} from '@relay-harness/rlh-context-engine'
import {
  PROMPT_ENHANCEMENT_CONTEXT_PURPOSE,
  PromptEnhancementError,
  type PromptEnhancementContextProvider,
} from '@relay-harness/rlh-prompt-enhancement'

export const name = 'prompt-enhancement-context-engine'
export const inject = ['promptEnhancement', 'contextEngine']

/** Resolve the durable preset actually running this log, including blank-session switches. */
function currentAgentPreset(agent: Parameters<PromptEnhancementContextProvider['prepare']>[0]['agent']): string | undefined {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type: string; data?: { agentPreset?: unknown } } | undefined
    if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      return event.data.agentPreset
    }
  }
  return agent.session.header.agentPreset
}

/** Register one adapter over the same Context Engine used by Agent steps. */
export function apply(ctx: Context): void {
  const provider: PromptEnhancementContextProvider = {
    id: name,
    async prepare(request) {
      const contextEngine = request.agent.ctx.get('contextEngine')
      if (contextEngine === undefined) {
        throw new PromptEnhancementError(
          'Prompt Enhancement Agent scope has no Context Engine',
          'PROMPT_ENHANCEMENT_CONTEXT_ENGINE_UNAVAILABLE',
        )
      }
      const cwd = request.agent.session.header.cwd ?? process.cwd()
      const agentPreset = currentAgentPreset(request.agent)
      request.signal.throwIfAborted()
      let prepared: PreparedStepContext | undefined
      try {
        prepared = await contextEngine.prepareStep({
          purpose: PROMPT_ENHANCEMENT_CONTEXT_PURPOSE,
          messages: [createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: request.draft }],
          })],
          signal: request.signal,
          cwd,
          caller: {
            sessionId: request.agent.session.id,
            agentId: request.agent.id,
            workspaceId: request.agent.session.header.cwd ?? 'global',
            ...agentPreset === undefined ? {} : { agentPreset },
            ...request.agent.session.header.origin === undefined
              ? {}
              : { origin: request.agent.session.header.origin },
          },
        })
      } catch (error: unknown) {
        if (request.signal.aborted) throw error
        if (error instanceof PromptEnhancementError) throw error
        throw new PromptEnhancementError(
          'Prompt Enhancement could not prepare context',
          'PROMPT_ENHANCEMENT_CONTEXT_PREPARATION_FAILED',
        )
      }
      request.signal.throwIfAborted()
      return {
        messages: prepared?.messages ?? [],
        trace: traceOf(prepared),
      }
    },
  }
  ctx.promptEnhancement.registerContextProvider(provider)
}

/** Project the engine result without copying or redefining its Evidence types. */
function traceOf(prepared: PreparedStepContext | undefined): JsonValue {
  const trace = snapshotJsonValue({
    purpose: PROMPT_ENHANCEMENT_CONTEXT_PURPOSE,
    ...prepared === undefined ? {} : {
      plan: {
        purpose: prepared.plan.purpose,
        budget: { ...prepared.plan.budget },
        contributors: prepared.plan.contributors.map(entry => ({
          contributorId: entry.contributorId,
          eligible: entry.eligible,
          reason: entry.reason,
          ...entry.budget === undefined ? {} : { budget: { ...entry.budget } },
        })),
      },
      decisions: prepared.decisions.map(decision => ({
        contributorId: decision.contributorId,
        outcome: decision.outcome,
        reasons: [...decision.reasons],
        ...decision.messageId === undefined ? {} : { messageId: decision.messageId },
        ...decision.priority === undefined ? {} : { priority: decision.priority },
        ...decision.chars === undefined ? {} : { chars: decision.chars },
        ...decision.tokens === undefined ? {} : { tokens: decision.tokens },
      })),
    },
    contributions: (prepared?.contributions ?? []).map(contribution => ({
      contributorId: contribution.contributorId,
      messageId: contribution.message.id,
      evidence: contribution.evidence.map(evidence => ({
        evidenceId: evidence.evidenceId,
        resource: {
          sourceId: evidence.resource.sourceId,
          key: evidence.resource.key,
          ...evidence.resource.revision === undefined ? {} : { revision: evidence.resource.revision },
        },
        ...evidence.digest === undefined ? {} : { digest: evidence.digest },
        truncated: evidence.truncated,
        freshness: evidence.freshness,
        verification: evidence.verification,
        ...evidence.domain === undefined ? {} : { domain: evidence.domain },
      })),
      ...contribution.coverage === undefined ? {} : {
        coverage: {
          searched: [...contribution.coverage.searched],
          notSearched: [...contribution.coverage.notSearched],
          ...contribution.coverage.rationale === undefined ? {} : { rationale: contribution.coverage.rationale },
          completeness: contribution.coverage.completeness,
        },
      },
    })),
  })
  if (trace === undefined) {
    throw new PromptEnhancementError(
      'Context Engine returned a non-JSON-serializable Prompt Enhancement trace',
      'PROMPT_ENHANCEMENT_CONTEXT_TRACE_INVALID',
    )
  }
  return trace
}
