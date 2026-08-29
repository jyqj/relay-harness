import { LlmAdapter, LlmError } from '@relay-harness/rlh-llm'
import type { GenerateOptions, StreamChunk } from '@relay-harness/rlh-llm'

export type Outcome = 'server' | 'auth' | 'success'

/** Shared deterministic adapter for unit and Loader composition tests. */
export class ScriptAdapter extends LlmAdapter {
  calls = 0
  constructor(private readonly outcomes: Outcome[]) { super() }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const outcome = this.outcomes[this.calls++]
    if (outcome === 'server') throw new LlmError('server failed', 'SERVER')
    if (outcome === 'auth') throw new LlmError('auth failed', 'AUTH')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
