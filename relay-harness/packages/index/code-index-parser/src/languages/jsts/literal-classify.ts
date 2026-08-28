/**
 * Literal classification for JS/TS: a priority-ordered regex table that maps
 * an indexed literal onto the `literal_kind` vocabulary the literal index
 * stores (route, url, topic, queue, env_key, config_key, sql, error_string,
 * log_key). Ported from the reference implementation's `jsts/extras.rs`
 * `classify_literal`; the kind and the config-key `key_path` land on
 * `LiteralRecord` columns when the record surface grows them — this phase's
 * record trims both, so classification gates which literals are worth
 * indexing (same as the reference, where unclassifiable literals are not
 * recorded).
 * @module
 */

import { Buffer } from 'node:buffer'

/** Classification vocabulary for indexed literals. */
export type LiteralKind =
  | 'route'
  | 'url'
  | 'topic'
  | 'queue'
  | 'env_key'
  | 'config_key'
  | 'sql'
  | 'error_string'
  | 'log_key'

/** Classification result carried by a record-worthy literal. */
export interface LiteralClassification {
  /** Matched category. */
  readonly kind: LiteralKind
  /** The literal itself for config keys (dotted settings paths), else `null`. */
  readonly keyPath: string | null
}

/** Confidence reported for a classified literal (`0.92 * 0.85`). */
export const LITERAL_CONFIDENCE = 0.782

/** Absolute URLs outrank every other category. */
const URL_RE = /https?:\/\/[^\s'"]+/

/** `SCREAMING_SNAKE_CASE` identifiers read as environment-variable keys. */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{2,}$/

/** Table mentions (`FROM users`, `join orders`, ...) mark SQL fragments. */
const SQL_TABLE_RE = /\b(?:from|join|update|into|table)\s+([^\W\d]\w*)/i

/** Human-facing failure vocabulary. */
const ERROR_STRING_RE = /\b(?:error|failed|failure|invalid|unauthorized|forbidden|timeout|not found)\b/i

/** Pub/sub topic names end in `-topic` / `-events` (dot or dash joined). */
const TOPIC_RE = /[-.](?:topic|events)$/i

/** Queue names carry a queue/fifo segment at either end. */
const QUEUE_RE = /(?:[-.]queue|[-.]fifo|^queue[-.]|^fifo[-.])/i

/** Dotted lowercase settings paths (`app.database.host`). */
const CONFIG_KEY_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/

/** Keywords whose presence marks logger/trace/event channel names. */
const LOG_KEY_WORDS: ReadonlySet<string> = new Set(['trace', 'logger', 'log', 'event'])

/** Literals below this byte size are never worth indexing. */
const MIN_LITERAL_BYTES = 3

/**
 * Classify a quote-stripped literal, first match wins in the reference
 * priority order (route > url > topic > queue > env_key > config_key > sql >
 * error_string > log_key).
 * @param value - quote-stripped literal text.
 * @returns the classification, or `null` when the literal is too short to
 * index or matches no category.
 */
export function classifyLiteral(value: string): LiteralClassification | null {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') < MIN_LITERAL_BYTES) return null
  if (value.startsWith('/')) return { kind: 'route', keyPath: null }
  if (URL_RE.test(value)) return { kind: 'url', keyPath: null }
  if (TOPIC_RE.test(value)) return { kind: 'topic', keyPath: null }
  if (QUEUE_RE.test(value)) return { kind: 'queue', keyPath: null }
  if (ENV_KEY_RE.test(value)) return { kind: 'env_key', keyPath: null }
  if (CONFIG_KEY_RE.test(value)) return { kind: 'config_key', keyPath: value }
  if (SQL_TABLE_RE.test(value)) return { kind: 'sql', keyPath: null }
  if (ERROR_STRING_RE.test(value)) return { kind: 'error_string', keyPath: null }
  const lower = value.toLowerCase()
  for (const word of LOG_KEY_WORDS) {
    if (lower.includes(word)) return { kind: 'log_key', keyPath: null }
  }
  return null
}
