/**
 * Int8 vector quantization and quantized cosine over plain typed arrays.
 *
 * The embedding tier stores one int8-quantized copy of every chunk embedding
 * in `chunks_vec` (`@relay-harness/rlh-code-index-sqlite`), cutting vector
 * storage to one byte per dimension plus three scalars. This module owns the
 * math both sides of that column: encode (`quantizeInt8`), decode
 * (`dequantizeInt8`), ranking distance without materializing a dequantized
 * vector (`cosineQuantized`), and a stable cache-key fingerprint
 * (`fingerprintVector`). Pure functions over typed arrays; no I/O and no
 * workspace dependencies.
 *
 * @module @relay-harness/rlh-code-index-search/vector-math
 */

import { createHash } from 'node:crypto'

/**
 * The int8 magnitude a quantized component may carry: symmetric per-vector
 * quantization maps the input's largest absolute component to exactly this
 * value, which keeps the representable range `[-127, 127]` symmetric instead
 * of the asymmetric `[-128, 127]` raw int8 allows.
 */
const INT8_MAGNITUDE_LIMIT = 127

/**
 * One vector's int8 quantization record.
 *
 * **Storage contract (locked):** {@link q} is a signed Int8Array of exactly
 * `dim` elements, one byte each. Persisting writes the byte view
 * `new Uint8Array(q.buffer)` — for single-byte elements this is a
 * byte-identical copy, so the stored BLOB has no byte order to pin and reads
 * back (`node:sqlite` surfaces plain `Uint8Array`) decode through
 * {@link dequantizeInt8} unchanged. `scale` and `norm` persist beside the BLOB
 * in their own REAL columns.
 */
export interface QuantizedVectorInt8 {
  /** Signed quantized components in `[-127, 127]`, input order preserved. */
  readonly q: Int8Array
  /** Dequantization multiplier; component `v[i] ≈ q[i] * scale`. */
  readonly scale: number
  /** L2 norm of the ORIGINAL float vector at quantization time. */
  readonly norm: number
}

/**
 * Quantize one float vector with symmetric per-vector int8 affinity.
 *
 * With `absMax = max_i |v_i|`, the scale is `absMax / 127` and each component
 * stores `round(v_i / scale)` clamped to `[-127, 127]`; dequantization error
 * per component is therefore bounded by `scale / 2`. The returned
 * {@link QuantizedVectorInt8.norm} is the ORIGINAL vector's L2 norm computed
 * before quantization, so ranking can divide by the true magnitude instead of
 * the quantization-shrunken one. An all-zero vector quantizes to all zeros
 * with `scale = 1` (division guard); its zero `norm` makes every
 * {@link cosineQuantized} against it `0`.
 * @param vector - the float vector to quantize; not mutated.
 * @returns the quantization record (see the storage contract on
 *   {@link QuantizedVectorInt8}).
 * @throws when the vector is empty or carries a non-finite component — both
 *   are caller bugs that would silently poison the stored tier.
 */
export function quantizeInt8(vector: Float32Array): QuantizedVectorInt8 {
  if (vector.length === 0) throw new Error('cannot quantize an empty vector')
  let absMax = 0
  let sumSquares = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error(`vector carries a non-finite component: ${value}`)
    }
    const magnitude = Math.abs(value)
    if (magnitude > absMax) absMax = magnitude
    sumSquares += value * value
  }
  const scale = absMax === 0 ? 1 : absMax / INT8_MAGNITUDE_LIMIT
  const q = new Int8Array(vector.length)
  for (const [index, value] of vector.entries()) {
    const scaled = Math.round(value / scale)
    q[index] = Math.min(INT8_MAGNITUDE_LIMIT, Math.max(-INT8_MAGNITUDE_LIMIT, scaled))
  }
  return { q, scale, norm: Math.sqrt(sumSquares) }
}

/**
 * Reinterpret a stored BLOB as signed int8 components. The BLOB is the byte
 * view of an Int8Array (see the storage contract on
 * {@link QuantizedVectorInt8}), so reversing is a reinterpretation, not a
 * conversion — no byte swapping exists at one byte per element.
 * @param bytes - the stored bytes; accepted as a view so sliced reads work.
 * @returns the signed components sharing `bytes`' buffer.
 */
function int8ViewOf(bytes: Uint8Array): Int8Array {
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)
}

/**
 * Decode one stored quantized vector back to float.
 *
 * Each component returns `q[i] * scale`. When `norm` is supplied the result is
 * additionally rescaled to exactly that L2 norm, compensating the systematic
 * magnitude shrink rounding causes — a no-op for ranking (cosine is scale
 * invariant) but the honest magnitude for callers that consume the vector
 * itself. A zero (or absent) current norm leaves the zero vector as zeros.
 * @param bytes - stored BLOB bytes (see the storage contract on
 *   {@link QuantizedVectorInt8}).
 * @param scale - the stored scale multiplier.
 * @param norm - optional stored original norm to renormalize the result to.
 * @returns the dequantized float vector.
 * @throws when `norm` is present but not a finite non-negative number.
 */
export function dequantizeInt8(bytes: Uint8Array, scale: number, norm?: number): Float32Array {
  if (norm !== undefined && (!Number.isFinite(norm) || norm < 0)) {
    throw new Error(`dequantizeInt8 norm must be a finite non-negative number, got ${norm}`)
  }
  const q = int8ViewOf(bytes)
  const out = new Float32Array(q.length)
  let sumSquares = 0
  for (const [index, component] of q.entries()) {
    const value = component * scale
    out[index] = value
    sumSquares += value * value
  }
  const current = Math.sqrt(sumSquares)
  if (norm !== undefined && current > 0) {
    const factor = norm / current
    for (const [index, value] of out.entries()) out[index] = value * factor
  }
  return out
}

/**
 * Cosine similarity between a float query vector and one stored quantized
 * vector, computed without materializing the dequantized vector.
 *
 * The algebra: with `q` the stored int8 components and `s` the stored scale,
 * `dot(query, dequantized) = Σ query[i] * (q[i] * s) = s * Σ query[i] * q[i]`,
 * and the stored vector's magnitude is the precomputed original `norm`, so
 *
 * ```
 * cosine = (scale * Σ query[i] * q[i]) / (|query| * norm)
 * ```
 *
 * Only the int8 bytes are touched — the dot accumulates exact small integers
 * times float query components, which is where the quantized ranking's
 * precision comes from. A zero `|query|` or zero `norm` returns `0` (cosine
 * is undefined there; `0` keeps ordering neutral). The result can exceed `1`
 * by the quantization error; callers that need a strict unit interval clamp.
 * @param query - the float query vector; every component must be finite for the
 *   result to stay `NaN`-free (the embedding client validates this with
 *   `Number.isFinite` before a query vector is ever returned).
 * @param bytes - stored BLOB bytes of the document vector.
 * @param scale - the stored scale multiplier.
 * @param norm - the stored original norm of the document vector.
 * @returns the cosine similarity; `NaN`-free whenever the query vector is finite.
 * @throws when `query.length` differs from the stored component count — a
 *   mismatch means the query was embedded with a different model or
 *   dimensionality and every score would be meaningless.
 */
export function cosineQuantized(query: Float32Array, bytes: Uint8Array, scale: number, norm: number): number {
  if (query.length !== bytes.length) {
    throw new Error(`cosineQuantized dimension mismatch: query ${query.length} vs stored ${bytes.length}`)
  }
  const q = int8ViewOf(bytes)
  let dot = 0
  let querySumSquares = 0
  for (const [index, queryValue] of query.entries()) {
    // Lengths were proven equal above, so the coalesce never fires; the
    // assertion-free read is the lint-mandated form over a signed view.
    // v8 ignore next -- unreachable coalesce, kept for the no-non-null-assertion rule
    dot += queryValue * (q.at(index) ?? 0)
    querySumSquares += queryValue * queryValue
  }
  const queryMagnitude = Math.sqrt(querySumSquares)
  if (queryMagnitude === 0 || norm === 0) return 0
  return (scale * dot) / (queryMagnitude * norm)
}

/**
 * Stable short fingerprint of one float vector, for cache keys that must
 * survive process restarts (`fingerprint(vec)` equality means byte-equal
 * vectors). Components serialize as IEEE-754 binary32 in explicit
 * little-endian byte order, so the digest does not depend on platform
 * endianness; the result is the first 16 hex characters of the SHA-256 digest.
 * @param vector - the vector to fingerprint; not mutated.
 * @returns 16 lowercase hex characters.
 */
export function fingerprintVector(vector: Float32Array): string {
  const view = new DataView(new ArrayBuffer(vector.length * 4))
  for (const [index, value] of vector.entries()) {
    view.setFloat32(index * 4, value, true)
  }
  return createHash('sha256').update(new Uint8Array(view.buffer)).digest('hex').slice(0, 16)
}
