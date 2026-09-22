/** Deterministic LLM response script; all retrieval and logging are real runtime work. */
import { CallId, LlmAdapter } from '@relay-harness/rlh-llm'

class ContextSnapshotAdapter extends LlmAdapter {
  calls = 0
  async *stream(request) {
    this.calls += 1
    if (!request.tools.some(tool => tool.name === 'retrieve_context')) throw new Error('context tool is not advertised')
    if (this.calls === 1) {
      const args = JSON.stringify({ query: 'spoolQuantaMarker', sources: ['code-index-recall'] })
      const id = CallId('context-snapshot-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'retrieve_context', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'retrieve_context', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const retrieved = request.messages.flatMap(message => message.content)
      .filter(block => block.type === 'tool-result').flatMap(block => block.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (this.calls !== 2 || !retrieved.includes('"verification":"verified"')) throw new Error('retrieval did not reach the next model request')
    if (!JSON.stringify(request.messages).includes('spoolQuantaMarker')) throw new Error('workspace source was not retrieved')
    const text = 'CONTEXT_TOOL_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'context-snapshot-backend'
/** Required runtime adapter registry. */
export const inject = ['llm']
/** Register the keyless response script.
 * @param {import('@relay-harness/cordis').Context} ctx - Runtime owning the adapter.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new ContextSnapshotAdapter())
}
