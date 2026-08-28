/**
 * Exit-policy envelope ported from the reference implementation
 * (`output_budget.rs`): passthrough semantics, byte-cap boundary behavior, the
 * never-embed-original guarantee, and the UTF-8-safe prefix walk.
 */

import { describe, expect, it } from 'vitest'
import { applyExitPolicy, safeJsonPrefixParse, utf8SafePrefix } from '../src/envelope.ts'
import type { OutputTruncationEnvelope } from '../src/envelope.ts'

const SAMPLE = { query: 'needle', tier: 'tiny', hits: [] }

const asEnvelope = (value: unknown): OutputTruncationEnvelope => value as OutputTruncationEnvelope

describe('utf8SafePrefix', () => {
  it('returns short text unchanged', () => {
    expect(utf8SafePrefix('hello', 100)).toBe('hello')
    expect(utf8SafePrefix('', 0)).toBe('')
    expect(utf8SafePrefix('hello', 0)).toBe('')
  })

  it('cuts ASCII at the exact budget', () => {
    expect(utf8SafePrefix('abcdef', 3)).toBe('abc')
  })

  it('never splits a multi-byte character while walking back the budget', () => {
    // a(1) 你(3) 好(3) 🙂(4) ，(3) — budgets landing inside any run fall back
    // whole; the trailing fullwidth comma also weighs the BMP-above-BMP lane.
    const text = 'aé你好🙂，'
    for (let max = 0; max < Buffer.byteLength(text, 'utf8'); max += 1) {
      const prefix = utf8SafePrefix(text, max)
      expect(text.startsWith(prefix)).toBe(true)
      expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(max)
      expect(prefix.includes('�')).toBe(false)
    }
  })

  it('keeps a trailing unpaired surrogate from breaking whole-character cuts', () => {
    // x(1) then an unpaired HIGH surrogate encoded as three U+FFFD bytes.
    const text = 'x\u{d800}'
    for (let max = 0; max <= Buffer.byteLength(text, 'utf8'); max += 1) {
      const prefix = utf8SafePrefix(text, max)
      expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(max)
    }
    // An astral pair at the END exercises the end-of-text width probe.
    const tail = 'ab\u{1f642}'
    expect(utf8SafePrefix(tail, Buffer.byteLength(tail))).toBe(tail)
    expect(utf8SafePrefix(tail, 2)).toBe('ab')
    // Every HIGH-surrogate pairing decision keeps whole-character cuts: an
    // unpaired surrogate rides as its own replacement run or drops entirely,
    // and an astral PAIR is included only when BOTH units fit.
    const probes = ['a\u{d800}x', 'a\u{d800}，', 'a\u{d800}\u{dfff}', 'a\u{d800}'] as const
    for (const probe of probes) {
      expect(utf8SafePrefix(probe, Buffer.byteLength(probe))).toBe(probe)
      expect(utf8SafePrefix(probe, 1)).toBe('a')
    }
    expect(utf8SafePrefix('a\u{d800}\u{dfff}', 1 + 4)).toBe('a\u{d800}\u{dfff}')
    expect(utf8SafePrefix('a\u{d800}\u{dfff}', 3)).toBe('a')
    // A leading LOW surrogate stands alone at scan time.
    expect(utf8SafePrefix('\u{dc00}x', Buffer.byteLength('\u{dc00}x'))).toBe('\u{dc00}x')
    expect(utf8SafePrefix('\u{dc00}x', 1)).toBe('')
  })
})

describe('applyExitPolicy', () => {
  it('passthrough ignores any budget', () => {
    const huge = 'x'.repeat(10_000)
    expect(applyExitPolicy(huge, 'passthrough', 1)).toBe(huge)
  })

  it('byte-cap keeps values at or under the limit untouched', () => {
    expect(applyExitPolicy(SAMPLE, 'byte-cap', Buffer.byteLength(JSON.stringify(SAMPLE), 'utf8'))).toEqual(SAMPLE)
  })

  it('one byte under the serialized length truncates', () => {
    const limit = Buffer.byteLength(JSON.stringify(SAMPLE), 'utf8') - 1
    const result = applyExitPolicy(SAMPLE, 'byte-cap', limit)
    expect(asEnvelope(result)._truncated).toBe(true)
    expect(asEnvelope(result)._max_chars).toBe(limit)
  })

  it('reports the original size inside the envelope', () => {
    const value = { data: 'y'.repeat(600) }
    const envelope = asEnvelope(applyExitPolicy(value, 'byte-cap', 400))
    expect(envelope._truncated).toBe(true)
    expect(envelope._original_chars).toBe(JSON.stringify(value).length)
    expect(envelope._max_chars).toBe(400)
    // The envelope itself serializes well under the original size.
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThan(500)
  })

  it('reparses a bounded prefix only when it is complete JSON on its own', () => {
    expect(safeJsonPrefixParse('3.14159')).toBe(3.14159)
    expect(safeJsonPrefixParse('[1,')).toBe('[1,')
    expect(safeJsonPrefixParse('{"a":')).toBe('{"a":')
  })

  it('degrades an unparseable preview to the bounded string and never embeds the original', () => {
    const value = { data: 'x'.repeat(10_000) }
    const rendered = JSON.stringify(applyExitPolicy(value, 'byte-cap', 1_000))
    const envelope = JSON.parse(rendered) as OutputTruncationEnvelope
    expect(envelope._truncated).toBe(true)
    expect(rendered.length).toBeLessThan(2_000)
    expect(rendered.includes('x'.repeat(5_000))).toBe(false)
    expect(typeof envelope.partial).toBe('string')
  })

  it('handles multi-byte payloads without corrupting the envelope', () => {
    const value = { data: '测'.repeat(2_000) }
    const envelope = asEnvelope(JSON.parse(JSON.stringify(applyExitPolicy(value, 'byte-cap', 300))))
    expect(envelope._truncated).toBe(true)
    expect(() => JSON.stringify(envelope)).not.toThrow()
  })

  it('an extreme tiny budget still yields a well-formed envelope', () => {
    const envelope = asEnvelope(applyExitPolicy(SAMPLE, 'byte-cap', 0))
    expect(envelope._truncated).toBe(true)
    expect(envelope._max_chars).toBe(0)
    expect(envelope.partial).toBe('')
  })

  it('bounds degenerate roots deterministically', () => {
    const passthroughRoot = applyExitPolicy<unknown>(undefined, 'passthrough')
    expect(passthroughRoot).toBeUndefined()
    // An empty serialization fits any budget: nothing to truncate.
    const serializedEmpty = applyExitPolicy(undefined, 'byte-cap', 5)
    expect(serializedEmpty).toBeUndefined()
    // `null` serializes to the four-byte literal and truncates like any value.
    expect(applyExitPolicy(null, 'byte-cap', 1)).toEqual({
      _truncated: true,
      _original_chars: 4,
      _max_chars: 1,
      partial: '',
    })
  })

  it('caps a graph explore answer at its four boundary classes', () => {
    // The explore tool applies the SAME policy the search tool does; the value
    // shape only changes the serialized width, so the boundaries are pinned on
    // a GraphExploreResult projection: tiny (fits), exact (byte-equal), and an
    // oversized single chunk that must never re-enter context.
    const answer = {
      op: 'relations',
      indexEpoch: { indexEpoch: 4, evidenceEpoch: 0 },
      nodes: [{ nodeId: 'n1', name: 'spoolQuantaMarker', kind: 'function', filePath: 'src/engine.ts', startLine: 1 }],
      edges: [],
      explain: { declared: ['CALLS'], readErrors: [], droppedReadErrorCount: 0 },
      truncated: false,
      candidateCount: 1,
      tier: 'tiny',
    }
    const serialized = JSON.stringify(answer)
    const tinyBudget = 18_000
    expect(applyExitPolicy(answer, 'byte-cap', tinyBudget)).toEqual(answer)
    expect(applyExitPolicy(answer, 'byte-cap', Buffer.byteLength(serialized, 'utf8'))).toEqual(answer)
    const envelope = asEnvelope(applyExitPolicy(answer, 'byte-cap', Buffer.byteLength(serialized, 'utf8') - 1))
    expect(envelope._truncated).toBe(true)
    expect(envelope._max_chars).toBe(Buffer.byteLength(serialized, 'utf8') - 1)
    expect(typeof envelope.partial).toBe('string')

    const oversized = { ...answer, nodes: [{ ...answer.nodes[0]!, name: 'y'.repeat(20_000) }] }
    const fatEnvelope = asEnvelope(JSON.parse(JSON.stringify(applyExitPolicy(oversized, 'byte-cap', 500))))
    expect(fatEnvelope._truncated).toBe(true)
    expect(JSON.stringify(fatEnvelope).includes('y'.repeat(1_000))).toBe(false)

    // Multibyte node names weigh UTF-8 bytes: the cut stays character-safe.
    const multibyte = { ...answer, nodes: [{ ...answer.nodes[0]!, name: '青花瓷'.repeat(600) }] }
    const multiEnvelope = asEnvelope(JSON.parse(JSON.stringify(applyExitPolicy(multibyte, 'byte-cap', 400))))
    expect(multiEnvelope._truncated).toBe(true)
    expect(() => JSON.stringify(multiEnvelope)).not.toThrow()
  })
})
