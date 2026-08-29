/**
 * Token budget controller: when a turn closes on a `max-tokens` cutoff, the
 * model's own stop decision gets overridden — the controller steers a
 * continue nudge into the closing turn so the model resumes where it was cut
 * off. Two bounds keep continuation honest: a per-turn continuation cap, and
 * diminishing-returns detection that stops steering once consecutive
 * continuations produce too little new output. Configuration and semantics
 * live in the package README.
 * @module @relay-harness/rlh-token-budget-controller
 */

import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type { Agent } from '@relay-harness/rlh-agent'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { MessageSource } from '@relay-harness/rlh-llm'

export const name = 'token-budget-controller'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: a non-integer or
 * sub-minimum value throws at plugin load, never a silent fall-back).
 */
export interface Config {
  /** Continue nudges allowed per turn (default 8). */
  maxContinuations?: number
  /**
   * Output tokens below which one continuation counts as unproductive
   * (default 500). A continuation whose usage is unreported counts as
   * productive — the cap alone bounds those.
   */
  minUsefulDeltaTokens?: number
  /** Consecutive unproductive continuations that stop the steering (default 2). */
  maxLowDeltaStreak?: number
}

export const Config: z<Config> = z.object({
  maxContinuations: z.number().default(8),
  minUsefulDeltaTokens: z.number().default(500),
  maxLowDeltaStreak: z.number().default(2),
})

/** The `{kind:'plugin'}` source stamped on every nudge this controller steers. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'token-budget-controller' }

const CONTINUE_NUDGE =
  'Your previous response was cut off at the output token limit, before you finished. '
  + 'Continue exactly where you left off: do not restart, do not summarize or repeat '
  + 'what you already produced, and call any tool needed to complete the remaining work.'

/** Per-agent continuation state; the WeakMap entry dies with the agent object. */
interface BudgetState {
  /** Turn the counter belongs to; continuation counts reset when the turn changes. */
  turn: number
  /** Nudges already steered into `turn`. */
  continuations: number
}

/**
 * Install the controller's stop-boundary listener.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; caps are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const maxContinuations = config.maxContinuations as number
  const minUsefulDeltaTokens = config.minUsefulDeltaTokens as number
  const maxLowDeltaStreak = config.maxLowDeltaStreak as number
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1) {
    throw new Error(`token-budget-controller: invalid maxContinuations ${maxContinuations} — must be an integer >= 1`)
  }
  if (!Number.isInteger(minUsefulDeltaTokens) || minUsefulDeltaTokens < 1) {
    throw new Error(`token-budget-controller: invalid minUsefulDeltaTokens ${minUsefulDeltaTokens} — must be an integer >= 1`)
  }
  if (!Number.isInteger(maxLowDeltaStreak) || maxLowDeltaStreak < 1) {
    throw new Error(`token-budget-controller: invalid maxLowDeltaStreak ${maxLowDeltaStreak} — must be an integer >= 1`)
  }

  const states = new WeakMap<Agent, BudgetState>()

  /**
   * The turn's per-step output sizes in order: the initial cutoff response
   * first, then one entry per continuation. Unreported usage yields
   * `undefined`, which the streak check treats as productive.
   */
  function turnOutputs(agent: Agent, turn: number): (number | undefined)[] {
    const outputs: (number | undefined)[] = []
    for (const event of agent.session.events) {
      if (event.type === 'assistant/message' && event.data.turn === turn) {
        outputs.push(event.data.usage?.outputTokens)
      }
    }
    return outputs
  }

  /** Whether the turn's closing finish is a `max-tokens` cutoff. */
  function closedOnMaxTokens(agent: Agent, turn: number): boolean {
    let closed = false
    for (const event of agent.session.events) {
      if (event.type === 'assistant/chunk'
        && event.data.turn === turn
        && event.data.chunk.type === 'finish') {
        closed = event.data.chunk.reason.kind === 'max-tokens'
      }
    }
    return closed
  }

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    /* v8 ignore next -- defensive: the loop re-checks abort immediately after the serial dispatch */
    if (signal.aborted) return
    if (!closedOnMaxTokens(agent, turn)) return

    const previous = states.get(agent)
    const state: BudgetState = previous !== undefined && previous.turn === turn
      ? previous
      : { turn, continuations: 0 }
    if (state.continuations >= maxContinuations) {
      states.set(agent, state)
      return
    }

    const continuationOutputs = turnOutputs(agent, turn).slice(1)
    const streak = continuationOutputs.slice(-maxLowDeltaStreak)
    const diminishing = streak.length >= maxLowDeltaStreak
      && streak.every(output => output !== undefined && output < minUsefulDeltaTokens)
    if (diminishing) {
      states.set(agent, state)
      return
    }

    state.continuations += 1
    states.set(agent, state)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: CONTINUE_NUDGE }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `continuation ${state.continuations}` },
    }))
  })
}
