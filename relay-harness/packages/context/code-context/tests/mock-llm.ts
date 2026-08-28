/**
 * Minimal scripted LLM adapter for the real-composition spec: streams one
 * text response per call and records every request it receives.
 */

import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@relay-harness/rlh-llm'
import { LlmAdapter } from '@relay-harness/rlh-llm'

/** Script entry that streams the given text as one block. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted adapter driven by a list of text responses, one per model call. */
export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private readonly responses: string[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.responses.shift()
    if (text === undefined) throw new Error('MockAdapter: script exhausted')
    for (const chunk of textResponse(text)) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
