/**
 * Shared root-session rollout budget: account model usage across a root Agent
 * and every local descendant, remind each Agent as thresholds are crossed, and
 * reject further model/tool work after exhaustion.
 *
 * @module @deepseek-ai/dsh-rollout-budget-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { MessageSource, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'rollout-budget-controller'
export const inject = ['agents', 'sessions', 'tools']

/** Required shared-budget limit plus reminder and weighting policy. */
export interface Config {
  /** Positive safe-integer weighted-token ceiling for one root session tree. */
  limitTokens: number
  /** Positive reminder thresholds, each strictly below `limitTokens`. */
  reminderAtRemainingTokens: number[]
  /** Weight applied to model output tokens (default 1). */
  samplingTokenWeight?: number
  /** Weight applied to uncached input tokens (default 1). */
  prefillTokenWeight?: number
}

export const Config: z<Config> = z.object({
  limitTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  reminderAtRemainingTokens: z.array(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).required(),
  samplingTokenWeight: z.number().min(0).default(1),
  prefillTokenWeight: z.number().min(0).default(1),
})

/** Fail-loud exhaustion surfaced through the ordinary Agent error lifecycle. */
export class RolloutBudgetError extends HarnessError {
  constructor(message: string) {
    super(message, 'ROLLOUT_BUDGET_EXCEEDED')
    this.name = 'RolloutBudgetError'
  }
}

/** Mutable accounting for one root session id. */
interface RootBudgetState {
  weightedTokensUsed: number
  /** Highest event seq already inspected for each local session. */
  readonly seenThrough: Map<SessionId, number>
}

/** Resolved, load-time-validated policy. */
interface ResolvedConfig {
  readonly limitTokens: number
  readonly reminderAtRemainingTokens: readonly number[]
  readonly samplingTokenWeight: number
  readonly prefillTokenWeight: number
}

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: name }
const REMINDER_SUMMARY = /^rollout budget reminder (\d+)$/

/** Resolve and revalidate configuration for direct programmatic construction. */
function resolveConfig(config: Config): ResolvedConfig {
  const { limitTokens, reminderAtRemainingTokens } = config
  const samplingTokenWeight = config.samplingTokenWeight ?? 1
  const prefillTokenWeight = config.prefillTokenWeight ?? 1
  if (!Number.isSafeInteger(limitTokens) || limitTokens < 1) {
    throw new Error('rollout-budget-controller: limitTokens must be a positive safe integer')
  }
  if (!Array.isArray(reminderAtRemainingTokens)
    || reminderAtRemainingTokens.some(threshold => !Number.isSafeInteger(threshold)
      || threshold < 1 || threshold >= limitTokens)) {
    throw new Error('rollout-budget-controller: reminderAtRemainingTokens must contain only positive safe integers below limitTokens')
  }
  for (const [field, weight] of [
    ['samplingTokenWeight', samplingTokenWeight],
    ['prefillTokenWeight', prefillTokenWeight],
  ] as const) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`rollout-budget-controller: ${field} must be finite and non-negative`)
    }
  }
  return {
    limitTokens,
    reminderAtRemainingTokens: [...reminderAtRemainingTokens],
    samplingTokenWeight,
    prefillTokenWeight,
  }
}

/** Weighted usage matching DSH's disjoint uncached-input accounting. */
function weightedUsage(usage: TokenUsage, config: ResolvedConfig): number {
  return Math.max(0, usage.outputTokens) * config.samplingTokenWeight
    + Math.max(0, usage.inputTokens) * config.prefillTokenWeight
}

/** Install shared accounting, request reminders, and exhaustion enforcement. */
export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input)
  const roots = new Map<SessionId, RootBudgetState>()

  /** Highest currently live durable ancestor, with cycle containment. */
  function rootOf(session: Session): SessionId {
    let root = session.id
    const seen = new Set<SessionId>([root])
    let parentId = session.header.parentSession
    while (parentId !== undefined && !seen.has(parentId)) {
      root = parentId
      seen.add(parentId)
      const parent = ctx.sessions.get(parentId)
      if (parent === undefined) break
      parentId = parent.header.parentSession
    }
    return root
  }

  /** Return or create the accounting owner for a session's root tree. */
  function stateOf(session: Session): RootBudgetState {
    const rootId = rootOf(session)
    const existing = roots.get(rootId)
    if (existing !== undefined) return existing
    const state: RootBudgetState = { weightedTokensUsed: 0, seenThrough: new Map() }
    roots.set(rootId, state)
    return state
  }

  /** Account one not-yet-seen own-suffix event. */
  function recordEvent(session: Session, event: SessionEvent): void {
    const state = stateOf(session)
    const previous = state.seenThrough.get(session.id) ?? -1
    if (event.seq <= previous) return
    state.seenThrough.set(session.id, event.seq)
    if (event.seq < (session.header.seedLength ?? 0)) return
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      state.weightedTokensUsed += weightedUsage(event.data.usage, config)
    }
  }

  /** Account a restored or already-live session exactly once per event seq. */
  function scanSession(session: Session): RootBudgetState {
    for (const event of session.events) recordEvent(session, event)
    return stateOf(session)
  }

  /** Read the greatest durable reminder index already delivered to this Agent. */
  function scanDelivered(agent: Agent): number {
    let greatest = 0
    for (const event of agent.session.events) {
      if (event.type !== 'user/message' || event.data.source.kind !== 'plugin'
        || event.data.source.plugin !== name || event.data.source.form !== 'notice') continue
      const match = REMINDER_SUMMARY.exec(event.data.source.summary)
      if (match !== null) greatest = Math.max(greatest, Number(match[1]))
    }
    return greatest
  }

  /** Current crossed-threshold count and non-negative displayed remainder. */
  function reminder(state: RootBudgetState): { index: number; remaining: number } {
    const remaining = Math.floor(config.limitTokens - state.weightedTokensUsed)
    const index = config.reminderAtRemainingTokens
      .filter(threshold => remaining <= threshold).length
    return { index, remaining }
  }

  /** Exhaustion error shared by pre-step and tool enforcement. */
  function exhaustedError(): RolloutBudgetError {
    return new RolloutBudgetError(
      `shared root-session rollout budget exhausted at ${config.limitTokens} weighted tokens`,
    )
  }

  // Root-tree accounting deliberately bypasses agent-scope filters while each
  // listener remains owned by this plugin's fiber.
  ctx.on('agent/session-start', ({ agent }) => {
    scanSession(agent.session)
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    recordEvent(session, event)
  }, { global: true })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    const state = scanSession(agent.session)
    if (state.weightedTokensUsed >= config.limitTokens) throw exhaustedError()
    if (decision.kind === 'reject') return decision
    const pending = reminder(state)
    const previous = scanDelivered(agent)
    if (pending.index <= previous) return decision
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: `You have ${pending.remaining} weighted tokens left in the shared root-session rollout budget.`,
      }],
      source: {
        ...PLUGIN_SOURCE,
        form: 'notice',
        summary: `rollout budget reminder ${pending.index}`,
      },
    })
    return { kind: 'enter', messages: [...decision.messages, message] }
  }, { global: true })

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    const state = scanSession(agent.session)
    return state.weightedTokensUsed >= config.limitTokens
      ? exhaustedError().message
      : undefined
  })
}
