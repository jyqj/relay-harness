/**
 * Public file-reference discovery records. This module contains types only so
 * generated Remote clients can consume it without Host runtime code.
 * @module @relay-harness/rlh-file-reference/types
 */

import type {} from '@relay-harness/rlh-llm'

/** One path-only completion candidate inside the target session cwd. */
export interface FileReferenceCandidate {
  /** User-facing path accepted by normal prompts and filesystem tools. */
  path: string
  /** Directories keep completion open; files finish the mention. */
  kind: 'file' | 'directory'
}

/** One user-mentioned file as admitted into a recall message. */
export interface FileReferenceRecallFile {
  /** The mentioned path exactly as the user wrote it. */
  path: string
  /** The filesystem-resolved path of the mention, when resolution succeeded. */
  resolvedPath?: string
  /** Opaque filesystem revision of the snapshot, when the target was stat-ed. */
  revision?: string
  /** Content bytes included in the snapshot, when any content was included. */
  bytes?: number
  /** Whether the included content stopped short of the whole file. */
  truncated: boolean
  /** Stable reason no content was included, when nothing was. */
  unavailable?: string
}

/** Durable source record of one injected file-content recall message. */
export interface FileReferenceRecallSource {
  kind: 'file-reference'
  /** Material read from the user's explicitly referenced files (`recall` context form). */
  form: 'recall'
  version: 1
  /** The step working directory the mentioned paths resolved against. */
  cwd: string
  /** One record per distinct mention, in first-occurrence order. */
  files: FileReferenceRecallFile[]
}

declare module '@relay-harness/rlh-llm' {
  interface MessageSourceMap {
    'file-reference': FileReferenceRecallSource
  }
}
