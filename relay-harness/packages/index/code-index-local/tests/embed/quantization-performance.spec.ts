/** Typical-batch quantization pressure gate: worker handoff is unjustified while this stays sub-frame. */

import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { quantizeInt8 } from '@relay-harness/rlh-code-index-search'
import { percentile95 } from '../../src/eval.ts'

describe('quantization main-thread pressure', () => {
  it('keeps a 16 x 1536 typical endpoint batch below a 25ms p95 guard', () => {
    const vectors = Array.from({ length: 16 }, (_, batch) =>
      Float32Array.from({ length: 1536 }, (_, index) => Math.sin(index + batch)))
    for (let warmup = 0; warmup < 5; warmup++) for (const vector of vectors) quantizeInt8(vector)
    const samples: number[] = []
    for (let run = 0; run < 30; run++) {
      const started = performance.now()
      for (const vector of vectors) quantizeInt8(vector)
      samples.push(performance.now() - started)
    }
    const p95 = percentile95(samples)
    console.info(`[perf] quantize 16x1536 p95=${p95.toFixed(3)}ms`)
    expect(p95).toBeLessThan(25)
  })
})
