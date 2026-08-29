/**
 * Behavior-correction guard: watches each agent's stop boundary for model
 * behavior deviations — an empty closing answer, a code block that was never
 * executed, a completion claim with no verifying tool activity — and steers
 * one corrective message into the closing turn instead of letting it end on
 * the deviation. Advisory and bounded: per-turn and consecutive caps always
 * let the turn close. Configuration and detection semantics live in the
 * package README.
 * @module @relay-harness/rlh-behavior-correction
 */

import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type { Agent } from '@relay-harness/rlh-agent'
import { assertNever, createUserMessage } from '@relay-harness/rlh-llm'
import type { MessageSource } from '@relay-harness/rlh-llm'
import type { AssistantMessage } from '@relay-harness/rlh-session'

export const name = 'behavior-correction'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: a non-integer
 * cap, a zero, or an uncompilable `completionPatterns` entry throws at plugin
 * load, never a silent fall-back). Detector toggles default on; every cap
 * defaults to the smallest useful bound.
 */
export interface Config {
  /** Corrective messages allowed per turn across all detectors (default 1). */
  maxCorrectionsPerTurn?: number
  /** Consecutive empty closing answers tolerated before the guard gives up (default 3). */
  maxConsecutiveEmpty?: number
  /** Detect a closing answer that is entirely whitespace (default true). */
  emptyAnswer?: boolean
  /** Detect a closing answer carrying a fenced code block in a turn with no tool calls (default true). */
  unexecutedCode?: boolean
  /** Detect a completion claim in a tool-free turn of a session that used tools earlier (default true). */
  unverifiedCompletion?: boolean
  /**
   * Regex sources naming a completion claim in the closing answer (default
   * English and Chinese claim phrases, matched case-insensitively). Each
   * entry must compile as a RegExp.
   */
  completionPatterns?: string[]
}

export const Config: z<Config> = z.object({
  maxCorrectionsPerTurn: z.number().default(1),
  maxConsecutiveEmpty: z.number().default(3),
  emptyAnswer: z.boolean().default(true),
  unexecutedCode: z.boolean().default(true),
  unverifiedCompletion: z.boolean().default(true),
  completionPatterns: z.array(z.string()).default([
    String.raw`\btask\s+(?:is\s+)?(?:complete|done|finished)\b`,
    String.raw`\b(?:all\s+)?done\b`,
    String.raw`\b(?:completed|finished)\b`,
    String.raw`\bthat\s+concludes\b`,
    String.raw`任务(?:已)?(?:完成|结束)`,
    String.raw`已完成`,
  ]),
})

/** The `{kind:'plugin'}` source stamped on every correction this guard steers. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'behavior-correction' }

const EMPTY_CORRECTION =
  'Your previous response was empty: it contained no text and no tool calls. '
  + 'If the task is complete, state the result explicitly; otherwise continue working on it.'

const UNEXECUTED_CODE_CORRECTION =
  'You produced a code block but did not call any tool, so nothing was executed. '
  + 'Describing a command or edit does not perform it. If the code was meant to run, '
  + 'call the appropriate tool now; if the task is already complete, conclude without the code block.'

const UNVERIFIED_COMPLETION_CORRECTION =
  'You declared the task complete, but this turn made no tool call that verifies the result. '
  + 'Before concluding, verify with a tool call (run the tests, re-read the changed file, '
  + 'or check the effect). If you are certain no verification is needed, explain why.'

/** One fenced-code-block opener anywhere in the closing answer. */
const CODE_FENCE = /(?:^|\n)```/

/** Per-agent correction state; the WeakMap entry dies with the agent object. */
interface CorrectionState {
  /** Turn the counter belongs to; correction counts reset when the turn changes. */
  turn: number
  /** Corrections already steered into `turn`. */
  corrections: number
  /** Consecutive turns closed on an empty answer. */
  consecutiveEmpty: number
}

/** Text of every text block in one assistant message, joined. */
function messageText(message: AssistantMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/**
 * The deviation found at one stop boundary, in inspection order. Empty
 * answers outrank code blocks, which outrank completion claims: an empty
 * answer carries nothing else to classify.
 */
type Deviation = 'empty-answer' | 'unexecuted-code' | 'unverified-completion'

/**
 * Install the guard's stop-boundary listener.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; caps and patterns are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const maxCorrectionsPerTurn = config.maxCorrectionsPerTurn as number
  const maxConsecutiveEmpty = config.maxConsecutiveEmpty as number
  if (!Number.isInteger(maxCorrectionsPerTurn) || maxCorrectionsPerTurn < 1) {
    throw new Error(`behavior-correction: invalid maxCorrectionsPerTurn ${maxCorrectionsPerTurn} — must be an integer >= 1`)
  }
  if (!Number.isInteger(maxConsecutiveEmpty) || maxConsecutiveEmpty < 2) {
    throw new Error(`behavior-correction: invalid maxConsecutiveEmpty ${maxConsecutiveEmpty} — must be an integer >= 2`)
  }
  const completionPatterns = (config.completionPatterns as string[]).map((source) => {
    if (source.length === 0) {
      throw new Error('behavior-correction: `completionPatterns` must not contain empty patterns')
    }
    try {
      return new RegExp(source, 'i')
    } catch (error: unknown) {
      throw new Error(`behavior-correction: \`completionPatterns\` entry ${JSON.stringify(source)} does not compile`, { cause: error })
    }
  })
  if (completionPatterns.length === 0 && (config.unverifiedCompletion as boolean)) {
    throw new Error('behavior-correction: `completionPatterns` must not be empty while `unverifiedCompletion` is enabled')
  }

  const states = new WeakMap<Agent, CorrectionState>()

  /** The correction text for one deviation. */
  function correctionText(deviation: Deviation): string {
    switch (deviation) {
      case 'empty-answer': return EMPTY_CORRECTION
      case 'unexecuted-code': return UNEXECUTED_CODE_CORRECTION
      case 'unverified-completion': return UNVERIFIED_COMPLETION_CORRECTION
      /* v8 ignore next -- closed-union exhaustiveness guard; unreachable in typed code */
      default: return assertNever(deviation, 'behavior-correction deviation')
    }
  }

  /**
   * Inspect the closing turn of one agent and return the deviation to
   * correct, if any. Reads only the session log: the turn ends on a plain
   * `stop` finish (max-tokens is the token budget's domain, tool-calls and
   * error finishes have their own owners), the closing assistant message is
   * the turn's last, and tool activity is counted per turn.
   */
  function inspect(agent: Agent, turn: number): Deviation | undefined {
    let lastFinishKind: string | undefined
    let lastAssistant: AssistantMessage | undefined
    let toolCallsThisTurn = 0
    let toolCallsBeforeTurn = 0
    for (const event of agent.session.events) {
      if (event.type === 'assistant/chunk'
        && event.data.turn === turn
        && event.data.chunk.type === 'finish') {
        lastFinishKind = event.data.chunk.reason.kind
      } else if (event.type === 'assistant/message' && event.data.turn === turn) {
        lastAssistant = event.data.message
      } else if (event.type === 'tool/call') {
        if (event.data.turn === turn) toolCallsThisTurn += 1
        else toolCallsBeforeTurn += 1
      }
    }
    if (lastFinishKind !== 'stop') return undefined
    /* v8 ignore next -- a `stop` finish is always preceded by its assistant/message append */
    if (lastAssistant === undefined) return undefined

    const text = messageText(lastAssistant)
    if ((config.emptyAnswer as boolean) && text.trim().length === 0) return 'empty-answer'
    if (toolCallsThisTurn > 0) return undefined
    if ((config.unexecutedCode as boolean) && CODE_FENCE.test(text)) return 'unexecuted-code'
    if ((config.unverifiedCompletion as boolean)
      && toolCallsBeforeTurn > 0
      && completionPatterns.some(pattern => pattern.test(text))) return 'unverified-completion'
    return undefined
  }

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    /* v8 ignore next -- defensive: the loop re-checks abort immediately after the serial dispatch */
    if (signal.aborted) return
    const deviation = inspect(agent, turn)
    const previous = states.get(agent)
    const state: CorrectionState = previous !== undefined && previous.turn === turn
      ? previous
      : { turn, corrections: 0, consecutiveEmpty: previous?.consecutiveEmpty ?? 0 }
    state.consecutiveEmpty = deviation === 'empty-answer' ? state.consecutiveEmpty + 1 : 0
    states.set(agent, state)

    if (deviation === undefined) return
    if (state.corrections >= maxCorrectionsPerTurn) return
    if (deviation === 'empty-answer' && state.consecutiveEmpty >= maxConsecutiveEmpty) return
    state.corrections += 1
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: correctionText(deviation) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: deviation },
    }))
  })
}
