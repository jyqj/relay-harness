/** Whole-message limits account for framing, Unicode and canonical token estimates. */
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { describe, expect, it } from 'vitest'
import { contextMessageFits, fitContextContribution, measureContextMessage } from '../src/budget.ts'
const message = (text: string) => createUserMessage({ source: { kind: 'plugin', plugin: 'budget' }, content: [{ type: 'text', text }] })

describe('complete context budget', () => {
  it('uses Unicode code points and charges complete framing', () => {
    const ctx = new Context()
    expect(measureContextMessage(ctx, message('<p>😀</p>'))).toEqual({ chars: 8, tokens: 6 })
    expect(contextMessageFits(ctx, message('<p>😀</p>'), { maxChars: 7, maxTokens: 100 })).toBe(false)
    expect(contextMessageFits(ctx, message('<p>😀</p>'), { maxChars: 8, maxTokens: 5 })).toBe(false)
  })
  it('honors a supplied token meter rather than assuming characters equal tokens', () => {
    const ctx = new Context()
    ctx.provide('tokenMeter', { estimateMessage: () => 100 })
    expect(measureContextMessage(ctx, message('short'))).toEqual({ chars: 5, tokens: 100 })
    expect(contextMessageFits(ctx, message('short'), { maxChars: 100, maxTokens: 99 })).toBe(false)
  })
  it('fits a renderer without cutting wrappers, and declines when its smallest observation cannot fit', () => {
    const ctx = new Context()
    const render = (size: number) => size < 1 ? undefined : { message: message(`<p>${'😀'.repeat(size)}</p>`) }
    const fit = fitContextContribution(ctx, { maxChars: 10, maxTokens: 100 }, render)
    expect(fit?.message.content).toEqual([{ type: 'text', text: '<p>😀😀😀</p>' }])
    expect(fitContextContribution(ctx, { maxChars: 7, maxTokens: 100 }, render)).toBeUndefined()
    expect(fitContextContribution(ctx, { maxChars: 100, maxTokens: 100 }, render, 2)?.message.content).toEqual([{ type: 'text', text: '<p>😀😀</p>' }])
  })
})
