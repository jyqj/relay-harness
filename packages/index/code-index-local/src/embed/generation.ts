/** Stable identity for one local embedding-materialization pipeline. */

import { createHash } from 'node:crypto'
import type { EmbeddingGenerationRow } from '@relay-harness/rlh-code-index-sqlite'

/** OpenAI-compatible wire/provider contract version. */
export const EMBEDDING_PROVIDER_ID = 'openai-compatible-v1'
/** Vector normalization contract; current vectors retain provider magnitude. */
export const EMBEDDING_NORMALIZATION_VERSION = 'none-v1'
/** Symmetric max-absolute int8 quantizer contract. */
export const EMBEDDING_QUANTIZER_VERSION = 'int8-maxabs-v1'
/** Parser-aware chunk identity/text contract. */
export const EMBEDDING_CHUNKER_VERSION = 'relay-parser-chunks-v1'

/** Input knobs that determine vector compatibility and coverage. */
export interface EmbeddingGenerationInput {
  readonly baseURL: string
  readonly model: string
  readonly dimensions?: number
}

/**
 * Strip credentials/query/fragment and normalize the endpoint path.
 * @param baseURL - configured OpenAI-compatible endpoint base.
 * @returns credential-free durable endpoint identity.
 */
export function embeddingEndpointIdentity(baseURL: string): string {
  const url = new URL(baseURL)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  return url.toString()
}

/**
 * Resolve and hash every compatibility-bearing pipeline knob.
 * @param input - endpoint, model, and optional fixed dimensions.
 * @returns durable generation record; provider-default dimensions remain an explicit mode.
 */
export function resolveEmbeddingGeneration(input: EmbeddingGenerationInput): EmbeddingGenerationRow {
  const identity = {
    providerId: EMBEDDING_PROVIDER_ID,
    endpointIdentity: embeddingEndpointIdentity(input.baseURL),
    model: input.model,
    configuredDimensions: input.dimensions ?? null,
    dimensionMode: input.dimensions === undefined ? 'provider-default' as const : 'fixed' as const,
    normalizationVersion: EMBEDDING_NORMALIZATION_VERSION,
    quantizerVersion: EMBEDDING_QUANTIZER_VERSION,
    chunkerVersion: EMBEDDING_CHUNKER_VERSION,
  }
  const generationId = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  return { generationId, ...identity }
}
