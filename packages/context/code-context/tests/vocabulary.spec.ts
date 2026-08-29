/**
 * Compile-face and consumer-contract tests for the code-index recall
 * vocabulary: the `code-index` source kind joins `MessageSourceMap`, narrows
 * through `kind`, and — the load-bearing contract — both downstream derived
 * consumers refuse to re-index the recall projection as fresh evidence.
 */

import { describe, expect, it } from 'vitest'
import { collectExtractionSources } from '@relay-harness/rlh-memory-extractor-llm/src/sources.ts'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { MessageSource } from '@relay-harness/rlh-llm'
import { Session, SessionId } from '@relay-harness/rlh-session'
import type { SessionEvent } from '@relay-harness/rlh-session'
import { extractSessionEventText } from '@relay-harness/rlh-session-query/src/extraction.ts'
import CodeContext from '../src/index.ts'
import type { CodeContextRecallSource } from '../src/types.ts'

const recallSource: CodeContextRecallSource = {
  kind: 'code-index',
  form: 'recall',
  version: 2,
  cwd: '/workspace',
  query: 'where is spoolQuantaMarker defined',
  hits: [
    {
      chunkId: 'chunk:src/engine.ts:1',
      filePath: 'src/engine.ts',
      language: 'typescript',
      contentHash: 'file-hash-v1',
      startLine: 1,
      endLine: 3,
      score: 42,
      scoreTrace: [{ label: 'rrf:lexical', value: 42 }],
      parserTier: 'tree-sitter',
      parserConfidence: 0.9,
      truncated: false,
    },
  ],
  epochs: { indexEpoch: 7, evidenceEpoch: 0 },
  hydrationEpochs: { indexEpoch: 7, evidenceEpoch: 0 },
}

/** Exhaustive narrowing over the merge-extensible source map. */
function kindOf(source: MessageSource): string {
  switch (source.kind) {
    case 'user': return 'user'
    case 'plugin': return 'plugin'
    case 'model': return 'model'
    case 'tool': return 'tool'
    case 'code-index': return `code-index:${source.form}:${source.hits.length}`
    default: {
      // Merge-extensible map: kinds owned by other plugins legitimately land here.
      return source.kind
    }
  }
}

describe('code-index recall vocabulary', () => {
  it('joins the message source map, round-trips through createUserMessage, and narrows', () => {
    const message = createUserMessage({
      source: recallSource,
      content: [{ type: 'text', text: 'src/engine.ts:1-3 42 lexical:fts' }],
    })
    expect(message.source).toEqual(recallSource)
    expect(kindOf(message.source)).toBe('code-index:recall:1')
  })

  it('fills the config schema defaults for an explicit empty section', () => {
    const validated = CodeContext.Config['~standard'].validate({}) as {
      issues?: readonly unknown[]
      value: { maxChars: number; maxHits: number; minQueryChars: number }
    }
    expect(validated.issues).toBeUndefined()
    expect(validated.value).toEqual({ maxChars: 65_536, maxHits: 8, minQueryChars: 8 })
  })

  it('keeps the recall projection out of the session-query corpus while direct text stays in', () => {
    const recalled: SessionEvent<'user/message'> = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: createUserMessage({
        source: recallSource,
        content: [{ type: 'text', text: 'src/engine.ts:1-3 42 lexical:fts' }],
      }),
      surfaceOp: 'append',
    }
    const direct: SessionEvent<'user/message'> = {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: recallSource.query }],
      }),
      surfaceOp: 'append',
    }
    expect(extractSessionEventText(recalled)).toBe('')
    expect(extractSessionEventText(direct)).toBe(recallSource.query)
  })

  it('keeps the recall projection out of memory extraction sources', () => {
    const id = SessionId('code-context-vocabulary')
    const session = Session.create(id, [], { version: 0, id, createdAt: 1, cwd: '/workspace', agentPreset: 'standard' })
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main' } },
      reason: 'initial',
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: recallSource.query }],
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      source: recallSource,
      content: [{ type: 'text', text: 'src/engine.ts:1-3 42 lexical:fts' }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const collected = collectExtractionSources(session, 1, {
      verifiedToolNames: new Set(),
      maxSourceChars: 1_000,
      maxInputChars: 10_000,
    })
    expect(collected?.sources.map(source => [source.kind, source.text])).toEqual([
      ['user', recallSource.query],
    ])
  })
})
