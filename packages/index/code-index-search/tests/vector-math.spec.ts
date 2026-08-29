import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  cosineQuantized,
  dequantizeInt8,
  fingerprintVector,
  quantizeInt8,
} from '../src/vector-math.ts'

/** Deterministic Gaussian-ish generator (xorshift32), so every run re-runs the same vectors. */
function makeGenerator(seed: number): () => number {
  let state = seed
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return (state / 0x1_0000_0000) * 2 - 1
  }
}

/** Build one deterministic pseudo-Gaussian float vector of the given dimension. */
function randomVector(dim: number, seed: number): Float32Array {
  const next = makeGenerator(seed)
  const vector = new Float32Array(dim)
  for (let index = 0; index < dim; index += 1) vector[index] = next()
  return vector
}

/** Plain float64 cosine between two float vectors. */
function cosineFloat32(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [index, av] of a.entries()) {
    const bv = b[index]!
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

describe('quantizeInt8', () => {
  it('round-trips a vector within half a scale step per component', () => {
    const vector = randomVector(256, 0x1234)
    const { q, scale, norm } = quantizeInt8(vector)
    expect(q.length).toBe(256)
    expect(scale).toBeCloseTo(Math.max(...[...vector].map(Math.abs)) / 127, 12)
    expect(norm).toBeCloseTo(Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0)), 5)

    const decoded = dequantizeInt8(new Uint8Array(q.buffer), scale)
    for (let index = 0; index < vector.length; index += 1) {
      expect(Math.abs(decoded[index]! - vector[index]!)).toBeLessThanOrEqual(scale / 2 + 1e-9)
    }
  })

  it('saturates at ±127 so the largest component is exact', () => {
    const vector = Float32Array.from([200, -200, 0.5, -0.25])
    const { q, scale } = quantizeInt8(vector)
    expect(scale).toBeCloseTo(200 / 127, 12)
    expect([...q]).toEqual([127, -127, 0, 0])
  })

  it('quantizes an all-zero vector to zeros with a division-guard scale of 1', () => {
    const { q, scale, norm } = quantizeInt8(new Float32Array(8))
    expect([...q]).toEqual(new Array<number>(8).fill(0))
    expect(scale).toBe(1)
    expect(norm).toBe(0)
  })

  it('refuses empty and non-finite inputs loudly', () => {
    expect(() => quantizeInt8(new Float32Array(0))).toThrow(/empty/)
    expect(() => quantizeInt8(Float32Array.from([1, Number.NaN]))).toThrow(/non-finite component/)
    expect(() => quantizeInt8(Float32Array.from([1, Number.POSITIVE_INFINITY]))).toThrow(/non-finite component/)
  })
})

describe('dequantizeInt8', () => {
  it('decodes the stored byte view through the Int8 reinterpretation', () => {
    const vector = randomVector(64, 0xbeef)
    const { q, scale } = quantizeInt8(vector)
    const bytes = new Uint8Array(q.buffer)
    expect(bytes.length).toBe(64)

    // A byte-identical copy (what node:sqlite returns) decodes identically,
    // proving the storage contract needs no byte-order state.
    const copied = new Uint8Array(bytes)
    const decoded = dequantizeInt8(copied, scale)
    for (let index = 0; index < vector.length; index += 1) {
      expect(decoded[index]!).toBeCloseTo(q[index]! * scale, 5)
    }
  })

  it('renormalizes to the stored original norm when one is supplied', () => {
    const vector = randomVector(128, 0xfeed)
    const { q, scale, norm } = quantizeInt8(vector)
    const plain = dequantizeInt8(new Uint8Array(q.buffer), scale)
    const plainNorm = Math.sqrt([...plain].reduce((sum, value) => sum + value * value, 0))
    expect(plainNorm).toBeLessThan(norm) // rounding shrinks the magnitude

    const renormalized = dequantizeInt8(new Uint8Array(q.buffer), scale, norm)
    const restored = Math.sqrt([...renormalized].reduce((sum, value) => sum + value * value, 0))
    expect(restored).toBeCloseTo(norm, 4)
  })

  it('keeps a zero vector at zeros under renormalization and rejects bad norms', () => {
    const { q, scale } = quantizeInt8(new Float32Array(4))
    expect([...dequantizeInt8(new Uint8Array(q.buffer), scale, 3)]).toEqual([0, 0, 0, 0])
    expect(() => dequantizeInt8(new Uint8Array(q.buffer), scale, -1)).toThrow(/norm/)
    expect(() => dequantizeInt8(new Uint8Array(q.buffer), scale, Number.NaN)).toThrow(/norm/)
  })
})

describe('cosineQuantized', () => {
  it('matches the float32 cosine within 1e-2 across dimensions', () => {
    for (const dim of [8, 64, 256]) {
      const document = randomVector(dim, 0xa100 + dim)
      const query = randomVector(dim, 0xb200 + dim)
      const { q, scale, norm } = quantizeInt8(document)
      const bytes = new Uint8Array(q.buffer)

      const quantized = cosineQuantized(query, bytes, scale, norm)
      const float = cosineFloat32(query, document)
      expect(Math.abs(quantized - float)).toBeLessThan(1e-2)
    }
  })

  it('is algebraically identical to ranking against the dequantized vector', () => {
    const document = randomVector(128, 0xc0de)
    const query = randomVector(128, 0xd00d)
    const { q, scale, norm } = quantizeInt8(document)
    const bytes = new Uint8Array(q.buffer)
    const decoded = dequantizeInt8(bytes, scale)

    // Reference: the same cosine but computed through the materialized
    // dequantized vector, denominator pinned to the stored original norm
    // (the module's declared contract — NOT the dequantized norm, which is
    // smaller by the rounding shrink).
    let dot = 0
    let queryNormSquared = 0
    for (const [index, value] of query.entries()) {
      dot += value * decoded[index]!
      queryNormSquared += value * value
    }
    const reference = dot / (Math.sqrt(queryNormSquared) * norm)
    expect(cosineQuantized(query, bytes, scale, norm)).toBeCloseTo(reference, 6)
    // Scale invariance: renormalizing the document must not move the cosine.
    expect(cosineQuantized(query, bytes, scale, norm))
      .toBeCloseTo(cosineQuantized(query, bytes, scale * 2, norm * 2), 12)
  })

  it('orders documents identically to the float32 ranking on a fixed batch', () => {
    const query = randomVector(64, 0xe000)
    const documents = [0x11, 0x22, 0x33, 0x44].map(seed => randomVector(64, seed))
    const expected = documents
      .map(document => cosineFloat32(query, document))
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.index)
    const actual = documents
      .map((document) => {
        const { q, scale, norm } = quantizeInt8(document)
        return cosineQuantized(query, new Uint8Array(q.buffer), scale, norm)
      })
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.index)
    expect(actual).toEqual(expected)
  })

  it('returns 0 for a zero query or a zero document and refuses dimension mismatch', () => {
    const document = randomVector(16, 0xf00d)
    const { q, scale, norm } = quantizeInt8(document)
    const bytes = new Uint8Array(q.buffer)
    expect(cosineQuantized(new Float32Array(16), bytes, scale, norm)).toBe(0)
    const { q: zeroQ, scale: zeroScale, norm: zeroNorm } = quantizeInt8(new Float32Array(16))
    expect(cosineQuantized(document, new Uint8Array(zeroQ.buffer), zeroScale, zeroNorm)).toBe(0)
    expect(() => cosineQuantized(randomVector(15, 1), bytes, scale, norm)).toThrow(/dimension mismatch/)
  })
})

describe('fingerprintVector', () => {
  it('is stable across recomputation and byte-equal copies, and diverges on change', () => {
    const vector = randomVector(32, 0x5eed)
    const first = fingerprintVector(vector)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprintVector(Float32Array.from(vector))).toBe(first)
    // A bit-flip in one component must almost surely change the digest.
    const mutated = Float32Array.from(vector)
    mutated[7] = mutated[7]! + 1e-3
    expect(fingerprintVector(mutated)).not.toBe(first)
    expect(fingerprintVector(new Float32Array(32))).not.toBe(first)
  })

  it('serializes in explicit little-endian order, independent of platform byte order', () => {
    // 1.0 is 0x3F800000 big-endian / 00 00 80 3F little-endian; the digest of a
    // single-component vector pins the canonical order this module locks in.
    expect(fingerprintVector(Float32Array.from([1]))).toBe(
      fingerprintVector(Float32Array.from([1]).reverse().reverse()),
    )
    // Cross-check against an independent little-endian SHA-256 computation.
    const expected = createHash('sha256').update(Uint8Array.of(0, 0, 0x80, 0x3f)).digest('hex').slice(0, 16)
    expect(fingerprintVector(Float32Array.from([1]))).toBe(expected)
  })
})
