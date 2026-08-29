/** GraphExplain collector contract: declaration semantics, error cap, truncation tokens, emptiness. */

import { describe, expect, it } from 'vitest'
import {
  GRAPH_EXPLAIN_MAX_READ_ERRORS,
  GraphExplainCollector,
} from '../../src/lane/explain.ts'

describe('GraphExplainCollector', () => {
  it('stays empty when only the static declaration was recorded', () => {
    const collector = new GraphExplainCollector()
    expect(collector.isEmpty()).toBe(true)
    collector.declareEdgeKinds(['CALLS', 'REFERENCES', 'TESTS'])
    expect(collector.isEmpty()).toBe(true)
    const explain = collector.finish()
    expect(explain.declared).toEqual(['CALLS', 'REFERENCES', 'TESTS'])
    expect(explain.isEmpty).toBe(true)
  })

  it('deduplicates traversed edge kinds in first-seen order and flips emptiness', () => {
    const collector = new GraphExplainCollector()
    collector.declareEdgeKinds(['CALLS'])
    collector.noteEdgeKind('call')
    collector.noteEdgeKind('http_bridge')
    collector.noteEdgeKind('call')
    expect(collector.isEmpty()).toBe(false)
    expect(collector.finish().edgeKindsUsed).toEqual(['call', 'http_bridge'])
  })

  it('formats read errors as "{op}: {error}" and drops entries past the cap', () => {
    const collector = new GraphExplainCollector()
    for (let index = 0; index < GRAPH_EXPLAIN_MAX_READ_ERRORS + 3; index++) {
      collector.recordReadError('reverse_callers', new Error(`boom ${index}`))
    }
    const explain = collector.finish()
    expect(explain.readErrors).toHaveLength(GRAPH_EXPLAIN_MAX_READ_ERRORS)
    expect(explain.readErrors[0]).toBe('reverse_callers: Error: boom 0')
    expect(explain.droppedReadErrorCount).toBe(3)
    expect(explain.isEmpty).toBe(false)
  })

  it('records a string rejection verbatim after the op prefix', () => {
    const collector = new GraphExplainCollector()
    collector.recordReadError('suggested_test_files', 'disk error')
    expect(collector.finish().readErrors).toEqual(['suggested_test_files: disk error'])
  })

  it('keeps the first truncated reason and keeps the flag on later recordings', () => {
    const collector = new GraphExplainCollector()
    collector.markTruncated('max_paths')
    collector.markTruncated('output_budget')
    const explain = collector.finish()
    expect(explain.truncated).toBe(true)
    expect(explain.truncatedReason).toBe('max_paths')
  })

  it('finishes to defensive copies so later collector writes stay invisible', () => {
    const collector = new GraphExplainCollector()
    collector.noteEdgeKind('call')
    const explain = collector.finish()
    collector.noteEdgeKind('http_bridge')
    collector.declareEdgeKinds(['CALLS'])
    expect(explain.edgeKindsUsed).toEqual(['call'])
    expect(explain.declared).toEqual([])
  })

  it('omits truncatedReason while nothing clipped the result', () => {
    const collector = new GraphExplainCollector()
    expect(collector.finish().truncatedReason).toBeUndefined()
  })
})
