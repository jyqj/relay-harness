/**
 * OpenAI-compatible embeddings client over plain `fetch`.
 *
 * One client serves one `(baseURL, apiKey, model)` endpoint. `embed` splits
 * its input into wire requests of at most
 * `min(batchSize, maxInputsPerRequest)` texts, gives every wire request its
 * own caller-signal-plus-deadline, validates the reply's record count, order,
 * and dimensionality, and accumulates the provider's `usage.prompt_tokens`
 * across batches for cost governance. Error mapping follows the attribution
 * and bounded-read conventions of the other direct-fetch adapters.
 *
 * @module @relay-harness/rlh-code-index-local/embed/client
 */

import { attributionHeaders, errorChain, normalizeApiKey } from '@relay-harness/rlh-llm'
import { deadline, TimeoutReason } from '@relay-harness/rlh-timeout'
import {
  EmbedError,
  EMBED_ABORTED,
  EMBED_DIMENSION_MISMATCH,
  EMBED_PROVIDER_ERROR,
  EMBED_RESPONSE_INVALID,
  EMBED_INVALID_CREDENTIAL,
  EMBED_TIMEOUT,
} from './errors.ts'

/** Endpoint replies larger than this are refused before parsing (4 MiB). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** The deadline code this client arms every batch with. */
const DEADLINE_CODE = 'EMBED_REQUEST_TIMEOUT'

/** The wire request an embeddings endpoint receives. */
interface EmbeddingsRequestBody {
  readonly model: string
  readonly input: readonly string[]
  readonly dimensions?: number
}

/** The subset of an embeddings reply this client reads. */
interface EmbeddingsResponseBody {
  data?: unknown
  usage?: unknown
}

/** One embedding record inside the reply's `data` array. */
interface EmbeddingRecord {
  embedding?: unknown
}

/** The subset of the reply's usage record this client reads. */
interface UsageRecord {
  prompt_tokens?: unknown
}

/** Options for {@link EmbeddingClient} — all resolved by the caller. */
export interface EmbeddingClientOptions {
  /** Endpoint base, treated as a prefix so deployment path segments survive. */
  readonly baseURL: string
  /** Bearer credential; normalized once at construction. */
  readonly apiKey: string
  /** Embedding model identity sent on every request. */
  readonly model: string
  /** Requested vector dimensionality; omit to lock onto the reply's dimension. */
  readonly dimensions?: number
  /** Texts packed into one wire request in the common case. */
  readonly batchSize: number
  /** Per-wire-request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Hard per-request input cap; an endpoint's advertised limit, not a choice. */
  readonly maxInputsPerRequest: number
  /** Injectable transport (tests); defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** One successful `embed` call's output. */
export interface EmbedResult {
  /** One vector per input text, same order. */
  readonly vectors: Float32Array[]
  /** `usage.prompt_tokens` summed over every wire request the call made. */
  readonly promptTokens: number
}

/** True for a fetch/`AbortSignal` abort, surfaced as `EMBED_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * True when a fetch rejection IS this batch's deadline: undici rejects with
 * the winning abort signal's `reason`, so a fired deadline surfaces as the
 * {@link TimeoutReason} itself rather than an `AbortError`.
 */
function isDeadline(error: unknown): error is TimeoutReason {
  return error instanceof TimeoutReason && error.code === DEADLINE_CODE
}

/** The embeddings client for one endpoint and model. */
export class EmbeddingClient {
  /** The model every request names. */
  readonly model: string

  private readonly base: string
  private readonly authorization: string
  private readonly requestInputs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private lockedDim: number | undefined

  /**
   * @param options - fully resolved endpoint configuration and transport.
   * @throws {EmbedError} with `EMBED_INVALID_CREDENTIAL` when the supplied API
   *   key is blank or carries characters no HTTP header can hold — refused
   *   here, at the one place construction still has the raw value, rather
   *   than as an opaque fetch `TypeError` per request.
   */
  constructor(options: EmbeddingClientOptions) {
    const checked = normalizeApiKey(options.apiKey)
    if (!checked.ok) {
      throw new EmbedError(
        checked.reason === 'empty'
          ? 'the embedding endpoint\'s API key is blank; configure a usable key or clear the endpoint'
          : 'the embedding endpoint\'s API key contains characters no HTTP header can carry; paste the raw key only',
        EMBED_INVALID_CREDENTIAL,
      )
    }
    this.base = options.baseURL.replace(/\/+$/, '')
    this.authorization = `Bearer ${checked.value}`
    this.model = options.model
    this.lockedDim = options.dimensions
    this.requestInputs = Math.max(1, Math.min(options.batchSize, options.maxInputsPerRequest))
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Embed the given texts, in order.
   * @param texts - input texts; an empty list returns without any request.
   * @param signal - caller cancellation fused with each batch's deadline.
   * @returns one vector per input plus the accumulated prompt-token spend.
   * @throws {EmbedError} with `EMBED_ABORTED` (caller cancellation),
   *   `EMBED_TIMEOUT` (a batch's deadline elapsed),
   *   `EMBED_PROVIDER_ERROR` (HTTP error status, transport failure),
   *   `EMBED_RESPONSE_INVALID` (non-JSON, over the read ceiling, record-count
   *   mismatch), or `EMBED_DIMENSION_MISMATCH` (a vector contradicts the
   *   configured or already-locked dimensionality). A failure raised after
   *   earlier batches of this call succeeded carries their billed
   *   `promptTokens` on `error.promptTokensUsed`.
   */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbedResult> {
    const vectors: Float32Array[] = []
    let promptTokens = 0
    for (let start = 0; start < texts.length; start += this.requestInputs) {
      if (signal?.aborted) {
        // Converted here so every abort leaving this class carries the
        // structured code; a raw DOMException would bypass the drain's routing.
        throw new EmbedError('the embedding request was aborted', EMBED_ABORTED)
      }
      const batch = texts.slice(start, start + this.requestInputs)
      let batchResult: { vectors: Float32Array[]; promptTokens: number }
      try {
        batchResult = await this.embedBatch(batch, signal)
      } catch (error: unknown) {
        // Batches already billed before this one failed: stamp the partial
        // spend onto the error so a failing job can still record its usage.
        if (error instanceof EmbedError && promptTokens > 0) {
          error.promptTokensUsed = promptTokens
        }
        throw error
      }
      // The wire request just completed, so its spend is billed even if the
      // reply's vectors fail validation below.
      promptTokens += batchResult.promptTokens
      for (const vector of batchResult.vectors) {
        // The configured dimension wins; without one, the first reply locks
        // the client's dimensionality for its whole lifetime, so a mid-life
        // endpoint change can never mix dimensions into one vector tier.
        this.lockedDim ??= vector.length
        if (vector.length !== this.lockedDim) {
          const mismatch = new EmbedError(
            `the endpoint returned a ${vector.length}-dimensional vector where ${this.lockedDim} was expected`,
            EMBED_DIMENSION_MISMATCH,
          )
          mismatch.promptTokensUsed = promptTokens
          throw mismatch
        }
        vectors.push(vector)
      }
    }
    return { vectors, promptTokens }
  }

  /** Run one wire request: deadline, POST, validate, extract vectors and usage. */
  private async embedBatch(batch: readonly string[], signal: AbortSignal | undefined): Promise<{
    vectors: Float32Array[]
    promptTokens: number
  }> {
    using batchDeadline = deadline(signal, this.timeoutMs, DEADLINE_CODE)
    const timeout = (cause: unknown): EmbedError => new EmbedError(
      `the embedding request timed out after ${this.timeoutMs}ms`,
      EMBED_TIMEOUT,
      { cause },
    )
    const aborted = (cause: unknown): EmbedError => new EmbedError(
      'the embedding request was aborted',
      EMBED_ABORTED,
      { cause },
    )
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}/embeddings`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': this.authorization,
          'content-type': 'application/json',
          'accept': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          ...(this.lockedDim !== undefined ? { dimensions: this.lockedDim } : {}),
        } satisfies EmbeddingsRequestBody),
        signal: batchDeadline.signal,
      })
    } catch (error: unknown) {
      if (isDeadline(error)) throw timeout(error)
      if (isAbortError(error)) throw aborted(error)
      throw new EmbedError(`the embedding request failed: ${errorChain(error)}`, EMBED_PROVIDER_ERROR, { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `the embedding endpoint answered HTTP ${status}`
      try {
        const body = await response.json() as { error?: { message?: unknown }; message?: unknown }
        const detail = typeof body.error?.message === 'string' ? body.error.message : undefined
        const flat = detail !== undefined && detail.length > 0
          ? detail
          : typeof body.message === 'string' && body.message.length > 0
            ? body.message
            : undefined
        if (flat !== undefined) message = flat
      } catch (error: unknown) {
        // An abort fired mid-body must surface as EMBED_ABORTED, not be
        // swallowed into a generic HTTP-error message; a malformed error body
        // only costs a richer message, never the real failure.
        if (isDeadline(error)) throw timeout(error)
        if (isAbortError(error)) throw aborted(error)
      }
      throw new EmbedError(message, EMBED_PROVIDER_ERROR)
    }

    const bodyText = await this.readBounded(response)
    let payload: EmbeddingsResponseBody
    try {
      payload = JSON.parse(bodyText) as EmbeddingsResponseBody
    } catch {
      throw new EmbedError('the embedding endpoint returned an unparsable JSON body', EMBED_RESPONSE_INVALID)
    }
    if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
      throw new EmbedError(
        `the embedding endpoint returned ${Array.isArray(payload.data) ? payload.data.length : 'no'} `
          + `embedding records for ${batch.length} inputs`,
        EMBED_RESPONSE_INVALID,
      )
    }
    const vectors = (payload.data as Array<EmbeddingRecord | null>).map((record, index) => {
      const embedding = record?.embedding
      if (!Array.isArray(embedding) || !embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new EmbedError(
          `the embedding endpoint returned no usable vector for input ${index + 1} of ${batch.length}`,
          EMBED_RESPONSE_INVALID,
        )
      }
      return Float32Array.from(embedding as number[])
    })
    const usage = payload.usage as UsageRecord | undefined
    const promptTokens = typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : 0
    return { vectors, promptTokens }
  }

  /** Read one reply body, refusing one that outgrows the read ceiling. */
  private async readBounded(response: Response): Promise<string> {
    const oversized = (): EmbedError => new EmbedError(
      `the embedding endpoint answered with more than ${MAX_RESPONSE_BYTES} bytes`,
      EMBED_RESPONSE_INVALID,
    )
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel()
      throw oversized()
    }
    if (response.body === null) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) throw oversized()
        chunks.push(value)
      }
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // The reply is already decided either way; cancellation is cleanup.
      })
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(body)
  }
}
