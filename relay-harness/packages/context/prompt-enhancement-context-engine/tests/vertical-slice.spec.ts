/** Real ContextEngine composition with the shipped @file and code contributors. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@relay-harness/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@relay-harness/rlh-agent'
import { CodeContextContributor } from '@relay-harness/rlh-code-context'
import CodeIndex from '@relay-harness/rlh-code-index'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  HydrateChunksRequest,
  HydrateChunksResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'
import ContextEngine from '@relay-harness/rlh-context-engine'
import { FileReferenceContentContributor } from '@relay-harness/rlh-file-reference-local'
import LocalFileSystem from '@relay-harness/rlh-fs-local'
import { createAssistantMessage, createUserMessage } from '@relay-harness/rlh-llm'
import PromptEnhancementService, {
  type PromptEnhancementProviderRequest,
} from '@relay-harness/rlh-prompt-enhancement'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SessionHistoryContext from '@relay-harness/rlh-session-history-context'
import TokenMeter from '@relay-harness/rlh-token-meter'
import * as adapterPlugin from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class ScriptedCodeIndex extends CodeIndex {
  readonly searches: SearchRequest[] = []

  status(): Promise<IndexStatusReport> {
    return Promise.reject(new Error('not used'))
  }

  refresh(_options?: RefreshOptions): Promise<RefreshSummary> {
    return Promise.reject(new Error('not used'))
  }

  search(request: SearchRequest): Promise<SearchResult> {
    this.searches.push(request)
    return Promise.resolve({
      query: request.query,
      tier: 'tiny',
      hits: [{
        chunkId: 'chunk:a',
        filePath: 'a.ts',
        language: 'typescript',
        contentHash: 'hash-a',
        startLine: 1,
        endLine: 1,
        score: 10,
        rank: 1,
        reasons: ['lexical:fts'],
        scoreTrace: [{ label: 'rrf:lexical', value: 10 }],
        parserTier: 'tree-sitter',
        parserConfidence: 1,
      }],
      candidateCount: 1,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      truncated: false,
      degraded: false,
      readErrors: [],
    })
  }

  hydrateChunks(_request: HydrateChunksRequest): Promise<HydrateChunksResult> {
    return Promise.resolve({
      chunks: [{
        chunkId: 'chunk:a',
        filePath: 'a.ts',
        language: 'typescript',
        contentHash: 'hash-a',
        startLine: 1,
        endLine: 1,
        text: 'export const parser = true',
        parserTier: 'tree-sitter',
        parserConfidence: 1,
        verification: 'source-verified',
      }],
      rejected: [],
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
    })
  }

  exploreGraph(_request: GraphExploreRequest): Promise<GraphExploreResult> {
    return Promise.reject(new Error('not used'))
  }
}

describe('Prompt Enhancement Context Engine vertical slice', () => {
  it('feeds direct-user @file and code intent through both real contributors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-prompt-enhancement-'))
    roots.push(root)
    await writeFile(join(root, 'a.ts'), 'export const parser = true\n', 'utf8')
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(SessionStore)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(ContextEngine)
    await ctx.plugin(SessionHistoryContext)
    await ctx.plugin(PromptEnhancementService)
    await ctx.plugin(ScriptedCodeIndex)
    const codeIndex = ctx.codeIndex as ScriptedCodeIndex
    ctx.contextEngine.registerContributor(new FileReferenceContentContributor(ctx, {
      maxFileBytes: 8_192,
      maxTotalBytes: 16_384,
    }))
    ctx.contextEngine.registerContributor(new CodeContextContributor(ctx, {
      maxChars: 8_192,
      maxHits: 4,
      minQueryChars: 1,
    }))
    await ctx.plugin(adapterPlugin)
    let providerRequest: PromptEnhancementProviderRequest | undefined
    ctx.promptEnhancement.registerProvider({
      id: 'capture',
      enhance: (request) => {
        providerRequest = request
        return Promise.resolve({
          enhancedDraft: 'Review @a.ts and fix parser semantics with tests.',
          assumptions: [],
          openQuestions: [],
          model: { provider: 'p', model: 'm' },
        })
      },
    })
    const session = ctx.sessions.create(SessionId('enhancement-context'), { meta: { cwd: root } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Earlier request' }],
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'p', model: 'm' },
        content: [{ type: 'text', text: 'Earlier successful answer' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const agent = {
      id: session.id,
      session,
      options: { provider: 'p', model: 'm' },
      ctx,
    } as unknown as Agent

    const outcome = await ctx.promptEnhancement.enhance(
      agent,
      'Review @a.ts and fix parser semantics',
      new AbortController().signal,
    )

    expect(outcome.kind).toBe('enhanced')
    expect(providerRequest?.context.messages.map(message => message.source.kind))
      .toEqual(['plugin', 'file-reference', 'code-index'])
    const contextTexts = providerRequest?.context.messages.map((message) => {
      const block = message.content[0]
      return block?.type === 'text' ? block.text : ''
    })
    expect(contextTexts).toHaveLength(3)
    expect(contextTexts?.[0]).toContain('Earlier successful answer')
    expect(contextTexts?.[1]).toContain('export const parser = true')
    expect(contextTexts?.[2]).toContain('export const parser = true')
    expect(codeIndex.searches).toEqual([expect.objectContaining({
      query: 'Review @a.ts and fix parser semantics',
      paths: ['a.ts'],
    })])
    expect(providerRequest?.context.trace).toMatchObject({
      purpose: 'prompt_enhancement',
      contributions: [
        { contributorId: 'session-history' },
        { contributorId: 'file-reference-content' },
        { contributorId: 'code-index-recall' },
      ],
    })
    const traceJson = JSON.stringify(providerRequest?.context.trace)
    expect(traceJson).toContain('"contributorId":"session-history","eligible":true')
    expect(traceJson).toContain('"contributorId":"file-reference-content","outcome":"selected"')
    expect(traceJson).toContain('"priority":"explicit-reference"')
  })
})
