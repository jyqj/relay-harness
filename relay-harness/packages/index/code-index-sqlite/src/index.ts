/**
 * SQLite storage repository for the local code-index capability.
 *
 * The store owns the derived on-disk schema behind `ctx.codeIndex`: fail-closed
 * admission of database files with in-place rebuild, the chunk-text codec over
 * the `(text_encoding, text)` column pair, exactly-once index-epoch writes,
 * the incremental file-delta writer, an LRU decoded-text cache, and a
 * {@link https://github.com/jyqj/relay-harness/blob/master/relay-harness/packages/index/code-index-search/src/port.ts | RetrievalPort}
 * adapter the ranking engine consumes. Scan/diff orchestration and everything
 * model-facing stay provider concerns. This package registers no service, no
 * Config, and no model-facing surface.
 * @module @relay-harness/rlh-code-index-sqlite
 */

export {
  CODE_INDEX_METADATA_EVIDENCE_EPOCH,
  CODE_INDEX_METADATA_EMBEDDING_EPOCH,
  CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX,
  CODE_INDEX_METADATA_INDEX_EPOCH,
  CODE_INDEX_SQLITE_APPLICATION_ID,
  CODE_INDEX_SQLITE_SCHEMA_VERSION,
  DERIVED_USER_TABLES,
  ensureCodeIndexSchema,
} from './ddl.ts'
export { decodeChunkText, encodeChunkText, isChunkTextCompressionCandidate, CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES, CHUNK_TEXT_ENCODING_PLAIN, CHUNK_TEXT_ENCODING_ZSTD } from './codec.ts'
export type { ChunkTextEncoding, EncodedChunkText } from './codec.ts'
export { openCodeIndexDatabase } from './open.ts'
export type { JournalMode } from './open.ts'
export { ensureEmbeddingGeneration } from './embedding-generation.ts'
export type { EmbeddingGenerationRow } from './embedding-generation.ts'
export { readEpochs, bumpIndexEpochOnceInTx, bumpEvidenceEpochOnceInTx, bumpEmbeddingEpochOnceInTx, assertExactAdvance } from './epoch.ts'
export type { EpochChannel } from './epoch.ts'
export { readVectorCoverage } from './reader.ts'
export { writeFilesDelta, writeResolvedEdges, writeChunkVectors } from './writer.ts'
export type {
  CallEdgeRowInput,
  ChunkVectorRowInput,
  ChunkUpsert,
  FileGraphDelta,
  FileUpsert,
  FilesDelta,
  FilesDeltaResult,
  GraphDeltaInput,
  ImportRowInput,
  LiteralRowInput,
  ResolvedEdgeFileUpdate,
  SymbolRefRowInput,
  SymbolRowInput,
  TestEdgeRowInput,
  WriteFilesDeltaOptions,
  WriteResolvedEdgesResult,
  WriteChunkVectorsResult,
} from './writer.ts'
export {
  DEFAULT_EMBED_JOB_MAX_ATTEMPTS,
  claimEmbedJobs,
  chunkRevisionsForFiles,
  chunkRevisionsMissingGeneration,
  completeEmbedJob,
  embedChunkInputs,
  enqueueEmbedJobs,
  failEmbedJob,
  pendingEmbedCount,
  resetFailedEmbedJobsForGeneration,
} from './embed-queue.ts'
export type {
  ClaimEmbedJobsOptions,
  ChunkRevisionRow,
  CompleteEmbedJobInput,
  EmbedChunkInput,
  EmbedJob,
  EmbedJobInput,
  EmbedJobUsage,
  EnqueueEmbedJobsOptions,
  EnqueueEmbedJobsResult,
  FailEmbedJobInput,
} from './embed-queue.ts'
export { rebuildTestEdgesForFiles, rebuildTestEdgesFull, testStemCandidateFragments } from './test-edges.ts'
export type { RebuildTestEdgesResult } from './test-edges.ts'
export { createRetrievalPort, createGraphReadFacet } from './reader.ts'
export type { CreateRetrievalPortOptions } from './reader.ts'
export { ChunkTextCache, chunkCacheKey, chunkTextCacheCapacityForTier } from './cache.ts'
export type { ChunkTextCacheStats } from './cache.ts'
