/**
 * Public vocabulary of the code-index recall contributor: the durable source
 * record carried by one injected recall message and its per-hit records. This
 * module contains types only. The `kind` joins the merge-extensible
 * {@link MessageSourceMap} so session-log consumers can discriminate the
 * messages without depending on this package's runtime.
 * @module @relay-harness/rlh-code-context/types
 */

import type {} from '@relay-harness/rlh-llm'

/**
 * Structural mirror of the code-index `EpochPair`, kept local so the source map
 * record stays self-contained for session-log consumers without this package's
 * runtime or the index package's type surface.
 */
export interface CodeIndexEpochs {
  /** Advances exactly once per committed content-bearing write transaction. */
  readonly indexEpoch: number
  /** Reserved for semantic-evidence ingestion; the vector writer advances it. */
  readonly evidenceEpoch: number
}

/** One retrieval hit as admitted into a code-index recall message. */
export interface CodeContextRecallHit {
  /** Stable chunk identity from the index (`chunk:<file>:<index>`). */
  chunkId: string
  /** Workspace-relative file path backing this hit. */
  filePath: string
  /** Stored language name used when the indexed chunk was parsed. */
  language: string
  /** Revalidated current-source revision. */
  contentHash: string
  /** Inclusive start line of the indexed span (1-based). */
  startLine: number
  /** Inclusive end line of the indexed span (1-based). */
  endLine: number
  /** Final fused score after rerank. */
  score: number
  /** Complete additive ranking bill copied from the search answer. */
  scoreTrace: Array<{ label: string; value: number }>
  /** Parser tier attached by the current hydration read. */
  parserTier: 'semantic' | 'tree-sitter' | 'heuristic' | 'generic'
  /** Parser confidence attached by the current hydration read. */
  parserConfidence: number
  /** Whether the rendered hit line stopped short of the full span. */
  truncated: boolean
}

/** Durable source record of one injected code-index recall message. */
export interface CodeContextRecallSource {
  kind: 'code-index'
  /** Ranked index hits read for the current step (`recall` context form). */
  form: 'recall'
  version: 2
  /** The step working directory the search ran against. */
  cwd: string
  /** The search query assembled from the claimed direct user text. */
  query: string
  /** One record per injected hit, in ranked order; omitted hits stayed outside the budgets. */
  hits: CodeContextRecallHit[]
  /** Epoch pair observed at search time; per-hit evidence binds to `contentHash`. */
  epochs: CodeIndexEpochs
  /** Epoch pair observed after hydration and source revalidation. */
  hydrationEpochs: CodeIndexEpochs
}

declare module '@relay-harness/rlh-llm' {
  interface MessageSourceMap {
    'code-index': CodeContextRecallSource
  }
}
