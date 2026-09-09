/**
 * Provider-local LLM circuit breaker over Agent request outcomes.
 * @module @relay-harness/rlh-llm-circuit-breaker
 */

import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import { LlmError } from '@relay-harness/rlh-llm'
import type { Agent } from '@relay-harness/rlh-agent'
import type {} from '@relay-harness/rlh-session'
import { CircuitBreaker, CircuitBreakerOpenError } from './breaker.ts'
import type { CircuitBreakerAdmission, CircuitBreakerPolicy } from './breaker.ts'

export { CircuitBreaker, CircuitBreakerOpenError } from './breaker.ts'
export type { CircuitBreakerAdmission, CircuitBreakerPolicy, CircuitBreakerState } from './breaker.ts'

export const name = 'llm-circuit-breaker'
export const inject = ['agents', 'sessions']

/** Provider-local breaker configuration, based on the imported client preset. */
export interface Config {
  /** Sliding outcome window in milliseconds (default 60000). */
  windowMs?: number
  /** Samples required before tripping (default 5). */
  minSamples?: number
  /** Failure ratio that trips after `minSamples` (default 0.5). */
  errorRateThreshold?: number
  /** Open cool-down and abandoned-probe lease in milliseconds (default 60000). */
  openMs?: number
  /** Concurrent half-open probes (default 1). */
  halfOpenMaxProbes?: number
  /** LLM failure codes counted as breaker failures. */
  failureCodes?: string[]
}

export const Config: z<Config> = z.object({
  windowMs: z.number().step(1).min(1).default(60_000),
  minSamples: z.number().step(1).min(1).default(5),
  errorRateThreshold: z.number().min(0).max(1).default(0.5),
  openMs: z.number().step(1).min(1).default(60_000),
  halfOpenMaxProbes: z.number().step(1).min(1).default(1),
  failureCodes: z.array(z.string()).default([
    'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  ]),
})

interface ResolvedConfig extends Required<Config> {}

/** Resolve fail-loud direct construction and detach code membership. */
function resolveConfig(config: Config): ResolvedConfig {
  const resolved = config as ResolvedConfig
  for (const [field, value] of [
    ['windowMs', resolved.windowMs],
    ['minSamples', resolved.minSamples],
    ['openMs', resolved.openMs],
    ['halfOpenMaxProbes', resolved.halfOpenMaxProbes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`llm-circuit-breaker: ${field} must be a positive safe integer`)
  }
  if (!Number.isFinite(resolved.errorRateThreshold)
    || resolved.errorRateThreshold < 0 || resolved.errorRateThreshold > 1) {
    throw new Error('llm-circuit-breaker: errorRateThreshold must be finite from 0 through 1')
  }
  const codes = new Set<string>()
  for (const code of resolved.failureCodes) {
    if (typeof code !== 'string' || code.length === 0 || codes.has(code)) {
      throw new Error('llm-circuit-breaker: failureCodes must contain unique non-empty strings')
    }
    codes.add(code)
  }
  return { ...resolved, failureCodes: [...codes] }
}

/** Install one shared breaker per provider route. */
export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input)
  const policy: CircuitBreakerPolicy = {
    windowMs: config.windowMs,
    minSamples: config.minSamples,
    errorRateThreshold: config.errorRateThreshold,
    openMs: config.openMs,
    halfOpenMaxProbes: config.halfOpenMaxProbes,
  }
  const failureCodes = new Set(config.failureCodes)
  const breakers = new Map<string, CircuitBreaker>()
  const breakerFor = (provider: string): CircuitBreaker => {
    const existing = breakers.get(provider)
    if (existing !== undefined) return existing
    const breaker = new CircuitBreaker(policy)
    breakers.set(provider, breaker)
    return breaker
  }
  // One agent drives at most one model request at a time, so the per-agent
  // per-provider admission queue is FIFO-exact: each outcome settles the stamp
  // of the request that preceded it. Shed requests admit nothing, and an
  // outcome with no pending stamp (never admitted, or an untracked source)
  // records as closed-admitted or not at all.
  const pending = new WeakMap<Agent, Map<string, CircuitBreakerAdmission[]>>()
  const admit = (agent: Agent, provider: string, admission: CircuitBreakerAdmission): void => {
    let perAgent = pending.get(agent)
    if (perAgent === undefined) {
      perAgent = new Map()
      pending.set(agent, perAgent)
    }
    const queue = perAgent.get(provider)
    if (queue === undefined) perAgent.set(provider, [admission])
    else queue.push(admission)
  }
  const settle = (agent: Agent | undefined, provider: string): CircuitBreakerAdmission | undefined => {
    return agent === undefined ? undefined : pending.get(agent)?.get(provider)?.shift()
  }

  ctx.on('agent/request', async (payload, next) => {
    const request = await next()
    let admission: CircuitBreakerAdmission
    try {
      admission = breakerFor(request.provider).check(Date.now())
    } catch (error: unknown) {
      const open = error as CircuitBreakerOpenError
      throw new LlmError(
        `provider "${request.provider}" circuit breaker is open`,
        'CIRCUIT_OPEN',
        { providerRetryAfterMs: open.retryAfterMs, cause: open },
      )
    }
    admit(payload.agent, request.provider, admission)
    return request
  }, { global: true })

  ctx.on('agent/request-error', async ({ agent, provider, failure }, next) => {
    const admission = settle(agent, provider)
    if (admission !== undefined) {
      breakerFor(provider).record(failureCodes.has(failure.code), Date.now(), admission)
    }
    return await next()
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const provider = event.data.message.source.provider
    breakerFor(provider).record(false, Date.now(), settle(ctx.agents.get(session.id), provider)
      ?? { state: 'closed' })
  }, { global: true })
}
