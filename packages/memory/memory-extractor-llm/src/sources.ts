/** Completed-turn projection into bounded, evidence-carrying extraction sources. */

import { createHash } from 'node:crypto'
import { memoryContainsSecret, memoryExcludesDerivedTool } from '@deepseek-ai/dsh-memory'
import type {
  MemoryExtractionRoute,
  MemoryExtractionSource,
} from '@deepseek-ai/dsh-memory/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  MEMORY_EXTRACTION_PROMPT_VERSION,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  renderExtractionPrompt,
} from './prompt.ts'

/** Source projection and route policy used for one capture. */
export interface ExtractionSourceConfig {
  readonly provider?: string
  readonly model?: string
  readonly verifiedToolNames: ReadonlySet<string>
  readonly maxSourceChars: number
  readonly maxInputChars: number
}

/** Bounded source snapshot and exact auxiliary route. */
export interface CollectedExtractionSources {
  readonly route: MemoryExtractionRoute
  readonly sources: MemoryExtractionSource[]
  readonly sourceHash: string
}

/**
 * Project one closed turn without admitting derived recall or failed results.
 * @param session - authoritative completed Session log.
 * @param turn - closed turn number.
 * @param config - route override, verification allowlist, and character budgets.
 * @returns bounded sources and hash, or undefined when the turn has no eligible source.
 */
export function collectExtractionSources(
  session: Session,
  turn: number,
  config: ExtractionSourceConfig,
): CollectedExtractionSources | undefined {
  const events = eventsForTurn(session.events, turn)
  if (events.length === 0) return undefined
  const route = extractionRoute(session, config)
  if (route === undefined) return undefined
  const calls = new Map(events.flatMap(event => event.type === 'tool/call'
    ? [[event.data.callId, event] as const]
    : []))
  const candidates: MemoryExtractionSource[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = clipText(contentText(event.data.content), config.maxSourceChars)
      if (text !== '' && !memoryContainsSecret(text)) {
        candidates.push({
          kind: 'user',
          text,
          evidence: {
            sessionId: session.id,
            eventSeqs: [event.seq],
            verification: 'user-statement',
            excerpt: text,
          },
        })
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const result = event.data.message.content[0]
    if (result.isError === true) continue
    const call = calls.get(result.toolCallId)
    if (call === undefined || memoryExcludesDerivedTool(call.data.name)) continue
    const text = clipText(contentText(result.content), config.maxSourceChars)
    if (text === '' || memoryContainsSecret(text)) continue
    const verified = config.verifiedToolNames.has(call.data.name)
    candidates.push({
      kind: 'tool-result',
      toolName: call.data.name,
      text,
      evidence: {
        sessionId: session.id,
        eventSeqs: [...event.sourceEventSeqs ?? [call.seq], event.seq],
        verification: verified ? 'successful-tool-result' : 'external-observation',
        callId: result.toolCallId,
        excerpt: text,
      },
    })
  }
  const sources = packSources(candidates, config.maxInputChars)
  if (sources.length === 0) return undefined
  const sourceHash = createHash('sha256').update(JSON.stringify({
    promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
    route,
    sources,
  })).digest('hex')
  return { route, sources, sourceHash }
}

function eventsForTurn(events: readonly SessionEvent[], turn: number): SessionEvent[] {
  const end = events.findLastIndex(event => event.type === 'turn/end' && event.data.turn === turn)
  if (end < 0) return []
  let start = end
  while (start >= 0) {
    const event = events[start]
    if (event?.type === 'turn/start' && event.data.turn === turn) break
    start -= 1
  }
  if (start < 0) return []
  return events.slice(start + 1, end)
}

function extractionRoute(session: Session, config: ExtractionSourceConfig): MemoryExtractionRoute | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const request = session.requestHeader()?.config
  if (request === undefined) return undefined
  return { provider: request.provider, model: request.model }
}

function packSources(candidates: readonly MemoryExtractionSource[], maxInputChars: number): MemoryExtractionSource[] {
  const priority = [...candidates].sort((a, b) => sourcePriority(a) - sourcePriority(b)
    || sourceLastSeq(b) - sourceLastSeq(a))
  const retained: MemoryExtractionSource[] = []
  for (const candidate of priority) {
    const proposed = [...retained, candidate].sort((a, b) => sourceLastSeq(a) - sourceLastSeq(b))
    const chars = Array.from(MEMORY_EXTRACTION_SYSTEM_PROMPT).length
      + Array.from(renderExtractionPrompt(proposed)).length
    if (chars <= maxInputChars) retained.push(candidate)
  }
  return retained.sort((a, b) => sourceLastSeq(a) - sourceLastSeq(b))
}

function sourcePriority(source: MemoryExtractionSource): number {
  if (source.kind === 'user') return 0
  return source.evidence.verification === 'successful-tool-result' ? 1 : 2
}

function sourceLastSeq(source: MemoryExtractionSource): number {
  return source.evidence.eventSeqs.at(-1) ?? -1
}

function contentText(content: readonly ContentBlock[]): string {
  return content.flatMap(blockText).map(text => text.trim()).filter(Boolean).join('\n')
}

function blockText(block: ContentBlock): string[] {
  switch (block.type) {
    case 'text': return [block.text]
    case 'tool-result': return block.content.flatMap(blockText)
    case 'reasoning':
    case 'tool-call':
    case 'image':
    default: return []
  }
}

function clipText(text: string, limit: number): string {
  const normalized = text.trim()
  const points = Array.from(normalized)
  return points.length <= limit ? normalized : points.slice(0, limit).join('')
}
