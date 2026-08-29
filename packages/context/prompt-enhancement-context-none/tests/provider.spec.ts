/** Explicit draft-only context provider registration and HMR teardown. */

import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import PromptEnhancementService from '@relay-harness/rlh-prompt-enhancement'
import * as plugin from '../src/index.ts'

describe('prompt-enhancement-context-none', () => {
  it('registers one empty provider and releases it with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptEnhancementService)
    const fiber = ctx.plugin(plugin)
    await fiber.await()
    expect(() => ctx.promptEnhancement.registerContextProvider({
      id: 'duplicate', prepare: vi.fn(),
    })).toThrow(/already registered/)
    await fiber.dispose()
    expect(() => ctx.promptEnhancement.registerContextProvider({
      id: 'replacement', prepare: () => Promise.resolve({ messages: [] }),
    })).not.toThrow()
  })
})
