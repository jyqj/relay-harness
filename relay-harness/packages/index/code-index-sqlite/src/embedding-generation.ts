/** Durable identity rows for embedding-pipeline generations. */

import type { DatabaseSync } from 'node:sqlite'

/** Complete identity of one embedding materialization pipeline. */
export interface EmbeddingGenerationRow {
  readonly generationId: string
  readonly providerId: string
  readonly endpointIdentity: string
  readonly model: string
  readonly configuredDimensions: number | null
  readonly dimensionMode: 'fixed' | 'provider-default'
  readonly normalizationVersion: string
  readonly quantizerVersion: string
  readonly chunkerVersion: string
}

/**
 * Admit one generation identity durably and fail on an impossible hash collision.
 * @param db - admitted code-index database.
 * @param generation - complete generation identity.
 * @param now - creation timestamp for a first insertion.
 */
export function ensureEmbeddingGeneration(
  db: DatabaseSync,
  generation: EmbeddingGenerationRow,
  now = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT OR IGNORE INTO embedding_generations (
      generation_id, provider_id, endpoint_identity, model,
      configured_dimensions, dimension_mode, normalization_version,
      quantizer_version, chunker_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generation.generationId,
    generation.providerId,
    generation.endpointIdentity,
    generation.model,
    generation.configuredDimensions,
    generation.dimensionMode,
    generation.normalizationVersion,
    generation.quantizerVersion,
    generation.chunkerVersion,
    now,
  )
  const stored = db.prepare(`
    SELECT provider_id AS providerId, endpoint_identity AS endpointIdentity,
      model, configured_dimensions AS configuredDimensions,
      dimension_mode AS dimensionMode, normalization_version AS normalizationVersion,
      quantizer_version AS quantizerVersion, chunker_version AS chunkerVersion
    FROM embedding_generations WHERE generation_id = ?
  `).get(generation.generationId) as Omit<EmbeddingGenerationRow, 'generationId'>
  for (const key of [
    'providerId',
    'endpointIdentity',
    'model',
    'configuredDimensions',
    'dimensionMode',
    'normalizationVersion',
    'quantizerVersion',
    'chunkerVersion',
  ] as const) {
    if (stored[key] !== generation[key]) {
      throw new Error(`embedding generation id collision for ${generation.generationId}: ${key} differs`)
    }
  }
}
