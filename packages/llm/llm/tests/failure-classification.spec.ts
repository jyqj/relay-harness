import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  QUOTA_EXCEEDED_CODE,
  TRANSIENT_FAILURE_CODES,
  classifyLlmFailure,
} from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/**
 * Behavior suite for structured failure classification: precedence
 * (context-overflow > provider-named delay > transient taxonomy > terminal)
 * and the periodic-vs-terminal quota split carried by `providerRetryAfterMs`.
 */

function failure(overrides: Partial<LlmFailure> & Pick<LlmFailure, 'code'>): LlmFailure {
  return { message: 'x', ...overrides }
}

describe('classifyLlmFailure', () => {
  it('classifies context overflow as context-overflow even when a provider delay is attached', () => {
    expect(classifyLlmFailure(failure({ code: CONTEXT_WINDOW_EXCEEDED_CODE })))
      .toEqual({ kind: 'context-overflow' })
    expect(classifyLlmFailure(failure({ code: CONTEXT_WINDOW_EXCEEDED_CODE, providerRetryAfterMs: 1000 })))
      .toEqual({ kind: 'context-overflow' })
  })

  it('classifies any failure carrying a valid provider delay as provider-scheduled', () => {
    expect(classifyLlmFailure(failure({ code: 'RATE_LIMIT', providerRetryAfterMs: 30_000 })))
      .toEqual({ kind: 'provider-scheduled', delayMs: 30_000 })
  })

  it('splits quota by the named-reset signal: periodic is schedulable, bare is terminal', () => {
    expect(classifyLlmFailure(failure({ code: QUOTA_EXCEEDED_CODE, providerRetryAfterMs: 5_000 })))
      .toEqual({ kind: 'provider-scheduled', delayMs: 5_000 })
    expect(classifyLlmFailure(failure({ code: QUOTA_EXCEEDED_CODE })))
      .toEqual({ kind: 'terminal' })
  })

  it('classifies every transient code without a provider delay as local-retryable', () => {
    for (const code of TRANSIENT_FAILURE_CODES) {
      expect(classifyLlmFailure(failure({ code }))).toEqual({ kind: 'local-retryable' })
    }
  })

  it('treats invalid provider delays as absent', () => {
    expect(classifyLlmFailure(failure({ code: 'RATE_LIMIT', providerRetryAfterMs: 0 })))
      .toEqual({ kind: 'local-retryable' })
    expect(classifyLlmFailure(failure({ code: 'RATE_LIMIT', providerRetryAfterMs: Number.NaN })))
      .toEqual({ kind: 'local-retryable' })
  })

  it('classifies auth, invalid-request, and unrecognized codes as terminal', () => {
    for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'INVALID_REQUEST', 'UNKNOWN', 'HTTP_418']) {
      expect(classifyLlmFailure(failure({ code }))).toEqual({ kind: 'terminal' })
    }
  })

  it('keeps EMPTY_RESPONSE local-retryable (degenerate completion, safe to repeat)', () => {
    expect(classifyLlmFailure(failure({ code: EMPTY_RESPONSE_CODE })))
      .toEqual({ kind: 'local-retryable' })
  })
})
