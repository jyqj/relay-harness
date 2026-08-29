/** Shared output schema for refresh build explanations. */

const DIRTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    marked: { type: 'integer', required: true },
    roundsRun: { type: 'integer', required: true },
    partial: { type: 'boolean', required: true },
    budgetExceeded: { type: 'boolean', required: true },
  },
} as const

const EMBEDDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    generationId: { type: 'string', required: true },
    missingChunks: { type: 'integer', required: true },
    jobsEnqueued: { type: 'integer', required: true },
    jobsDeduplicated: { type: 'integer', required: true },
    jobsReset: { type: 'integer', required: true },
    batchesClaimed: { type: 'integer', required: true },
    batchesWritten: { type: 'integer', required: true },
    jobsCompleted: { type: 'integer', required: true },
    jobsFailed: { type: 'integer', required: true },
  },
} as const

/** Refresh explanation schema shared by status and refresh tool results. */
export const BUILD_EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', required: true, enum: ['full', 'scoped'] },
    requestedPaths: { type: 'integer', required: true },
    pass: { type: 'string', required: true, enum: ['ran', 'skipped'] },
    degraded: { type: 'boolean', required: true },
    degradationReasons: { type: 'array', required: true, items: { type: 'string' } },
    dirty: { required: true, oneOf: [{ type: 'null' }, DIRTY_SCHEMA] },
    embedding: { required: true, oneOf: [{ type: 'null' }, EMBEDDING_SCHEMA] },
  },
} as const
