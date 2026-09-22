/** Complete model-message accounting shared by planning and context providers. */
import type { Context } from '@relay-harness/cordis'
import type { ContentBlock, UserMessage } from '@relay-harness/rlh-llm'
import type { ContextBudget, ContributedStepContext } from './types.ts'

/** Measure one complete message, including every text wrapper and non-text block.
 * @param ctx - Context with an optional canonical token meter.
 * @param message - Complete model-visible message.
 * @returns Unicode code points and estimated tokens charged by the engine.
 */
export function measureContextMessage(ctx: Context, message: UserMessage): { chars: number; tokens: number } {
  const chars = contentChars(message.content)
  const meter = ctx.get('tokenMeter') as { estimateMessage(message: UserMessage): number } | undefined
  return { chars, tokens: meter?.estimateMessage(message) ?? Math.ceil(chars / 4) + 4 }
}

/** Test the complete message against the request's two independent limits.
 * @param ctx - Context providing the optional token meter.
 * @param message - Final rendered message, including provenance and framing.
 * @param budget - Resolved request allowance.
 * @returns Whether both allowances contain the complete message.
 */
export function contextMessageFits(ctx: Context, message: UserMessage, budget: ContextBudget): boolean {
  const measured = measureContextMessage(ctx, message)
  return measured.chars <= budget.maxChars && measured.tokens <= budget.maxTokens
}

/** Find a budget-fitting rendering without clipping serialized evidence or message framing.
 * @param ctx - Context providing the optional token meter.
 * @param budget - Complete rendered-message allowance.
 * @param render - Pure rendering from a body allowance; undefined means too little room for an observation.
 * @param maxBodyChars - Provider-owned maximum body allowance.
 * @returns A complete admitted rendering, or undefined when even its smallest observation cannot fit.
 */
export function fitContextContribution(
  ctx: Context,
  budget: ContextBudget,
  render: (maxBodyChars: number) => ContributedStepContext | undefined,
  maxBodyChars: number = budget.maxChars,
): ContributedStepContext | undefined {
  let high = Math.min(maxBodyChars, budget.maxChars)
  const complete = render(high)
  if (complete !== undefined && contextMessageFits(ctx, complete.message, budget)) return complete
  let low = 0
  let best: ContributedStepContext | undefined
  while (low <= high) {
    const limit = low + Math.floor((high - low) / 2)
    const candidate = render(limit)
    if (candidate === undefined) low = limit + 1
    else if (contextMessageFits(ctx, candidate.message, budget)) {
      best = candidate
      low = limit + 1
    } else high = limit - 1
  }
  return best
}

function contentChars(content: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') chars += Array.from(block.text).length
    else if (block.type === 'tool-call') chars += Array.from(block.name + block.arguments).length
    else if (block.type === 'tool-result') chars += contentChars(block.content)
    else chars += Array.from(JSON.stringify(block)).length
  }
  return chars
}
