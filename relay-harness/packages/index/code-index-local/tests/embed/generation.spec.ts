/** Embedding generation identity: every compatibility-bearing knob participates. */

import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_CHUNKER_VERSION,
  EMBEDDING_NORMALIZATION_VERSION,
  EMBEDDING_PROVIDER_ID,
  EMBEDDING_QUANTIZER_VERSION,
  resolveEmbeddingGeneration,
} from '../../src/embed/generation.ts'

describe('resolveEmbeddingGeneration', () => {
  it('is stable across URL noise but changes for endpoint, model, and dimensions', () => {
    const base = resolveEmbeddingGeneration({
      baseURL: 'https://user:secret@example.test/v1/?routing=ignored#fragment',
      model: 'embed-a',
      dimensions: 768,
    })
    const equivalent = resolveEmbeddingGeneration({
      baseURL: 'https://example.test/v1',
      model: 'embed-a',
      dimensions: 768,
    })
    expect(base).toEqual(equivalent)
    expect(base).toMatchObject({
      providerId: EMBEDDING_PROVIDER_ID,
      endpointIdentity: 'https://example.test/v1',
      model: 'embed-a',
      configuredDimensions: 768,
      dimensionMode: 'fixed',
      normalizationVersion: EMBEDDING_NORMALIZATION_VERSION,
      quantizerVersion: EMBEDDING_QUANTIZER_VERSION,
      chunkerVersion: EMBEDDING_CHUNKER_VERSION,
    })
    expect(base.generationId).toMatch(/^[0-9a-f]{64}$/u)
    for (const changed of [
      resolveEmbeddingGeneration({ baseURL: 'https://other.test/v1', model: 'embed-a', dimensions: 768 }),
      resolveEmbeddingGeneration({ baseURL: 'https://example.test/v1', model: 'embed-b', dimensions: 768 }),
      resolveEmbeddingGeneration({ baseURL: 'https://example.test/v1', model: 'embed-a', dimensions: 384 }),
    ]) expect(changed.generationId).not.toBe(base.generationId)
  })

  it('represents endpoint-selected dimensions explicitly instead of omitting the field', () => {
    expect(resolveEmbeddingGeneration({ baseURL: 'https://example.test', model: 'embed' })).toMatchObject({
      configuredDimensions: null,
      dimensionMode: 'provider-default',
    })
  })
})
