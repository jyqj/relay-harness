/**
 * Exit-side output budgeting for the code-index tool suite, ported from the
 * reference implementation (`output_budget.rs` in codecortex cc-server): one
 * enforcement point that caps a successful canonical value's serialized JSON
 * before it becomes model context. Per-tool budget VALUES keep their source
 * in the seam's tier tables (`repoSizeTierMaxOutputChars`); this module owns
 * only HOW a cap is applied. Enforcement is a protection layer, not a
 * correctness layer — provider-side budgets (top-K ranking, tier clamps)
 * remain the honest bound, and this exit pass bounds the pathological
 * remainder instead of being load-bearing on its own.
 *
 * @module @relay-harness/rlh-tool-code-index/envelope
 */

import type { JsonValue } from '@relay-harness/rlh-session'

/** Reserved wrapper headroom subtracted from a byte cap before previewing: the
 * truncation envelope's own keys plus jitter stay under the original budget.
 * Ported verbatim from the reference implementation's 256-char reserve. */
export const TRUNCATION_ENVELOPE_RESERVE_BYTES = 256

/**
 * Model-facing truncated-output envelope replacing an over-budget value. The
 * old reference fallback embedded the ORIGINAL value when the bounded preview
 * was not valid JSON, which silently defeated the budget for large strings and
 * objects; here `partial` degrades to the bounded preview STRING itself, so the
 * original oversized payload can never re-enter model context through this
 * module.
 */
export interface OutputTruncationEnvelope {
  /** Always true in this envelope shape (absent means the value passed uncapped). */
  readonly _truncated: true
  /** Complete serialized size of the discarded value, in UTF-8 bytes. */
  readonly _original_chars: number
  /** The budget that was exceeded, in UTF-8 bytes. */
  readonly _max_chars: number
  /** A bounded UTF-8-safe preview of the serialized value: reparsed when the prefix is itself valid JSON, else the prefix string. */
  readonly partial: JsonValue
}

/**
 * Exit policy for one code-index tool. `passthrough` tools bound their output
 * inside execution (the status report is naturally small; the refresh summary
 * is fixed-shape) or owe their cap to the engine (candidate ranking); adding a
 * byte cap there would change observable behavior, so any new cap is a
 * deliberate decision mirroring the reference policy table. `byte-cap` caps the
 * complete serialized canonical value.
 */
export type ExitPolicy = 'passthrough' | 'byte-cap'

/** Encoded UTF-8 width of one UTF-16 code unit under Node's encoder.
 *
 * @param code - the current code unit.
 * @param next - the following code unit when present, else undefined at end of text.
 * @returns the byte width the encoder emits for this unit. */
function utf8UnitWidth(code: number, next: number | undefined): number {
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  // A HIGH surrogate paired with a following LOW surrogate shares one
  // four-byte run; any unpaired surrogate encodes standalone as three
  // replacement bytes. The pairing comparison fails closed on an absent
  // `next`. Atomic pair advancement never positions a scan step ON a pair's
  // trailing LOW unit, so it never takes this branch — v8 cannot see that,
  // hence the ignore directive.
  /* v8 ignore next */
  if (code >= 0xd800 && code < 0xdc00) return next !== undefined && next >= 0xdc00 && next <= 0xdfff ? 4 : 3
  return 3
}

/**
 * Longest UTF-8-safe prefix of `text` within `maxBytes`, ported from the
 * reference implementation's `utf8_prefix`. The walk advances whole code
 * POINTS, so a multi-byte sequence — including a four-byte surrogate pair —
 * contributes its bytes atomically or is left out entirely; every produced cut
 * sits on a character boundary by construction. Unpaired surrogates were
 * replaced by U+FFFD at encoding time and weigh three bytes each.
 *
 * @param text - the complete text.
 * @param maxBytes - the budget in UTF-8 bytes; zero or less yields the empty string.
 * @returns the longest whole-character prefix within the budget.
 */
export function utf8SafePrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let end = 0
  let used = 0
  while (end < text.length) {
    const code = text.charCodeAt(end)
    const paired = code >= 0xd800 && code < 0xdc00 && end + 1 < text.length
    const width = utf8UnitWidth(code, paired ? text.charCodeAt(end + 1) : undefined)
    if (used + width > maxBytes) break
    used += width
    end += paired ? 2 : 1
  }
  return text.slice(0, end)
}

/**
 * Best-effort reparse of a bounded preview: a byte-cut prefix that happens to
 * be complete JSON on its own (typically a sliced numeric literal) becomes
 * structured data; anything else degrades to the bounded preview STRING itself,
 * so the original oversized payload can never ride back into context through
 * this module.
 *
 * @param preview - the bounded UTF-8-safe prefix of a serialization.
 * @returns the parsed preview, or the preview unchanged when it is not valid JSON.
 */
export function safeJsonPrefixParse(preview: string): JsonValue {
  try {
    return JSON.parse(preview) as JsonValue
  } catch {
    // A cut inside any quoted production cannot be repaired structurally; the
    // caller keeps the bounded string rather than the original value.
    return preview
  }
}

/**
 * Passthrough exit: hand the canonical value through untouched; the budget is
 * ignored.
 *
 * @param value - the successful canonical value (lossless JSON).
 * @param policy - `passthrough`.
 * @param maxChars - ignored.
 * @returns the canonical value unchanged.
 */
export function applyExitPolicy<T>(value: T, policy: 'passthrough', maxChars?: number): T

/**
 * Byte-cap exit: serialize the lossless-JSON value and hand it through while
 * it fits `maxChars` UTF-8 bytes; an oversized value becomes an
 * {@link OutputTruncationEnvelope} whose bounded preview never re-embeds the
 * discarded payload.
 *
 * @param value - the successful canonical value (lossless JSON).
 * @param policy - `byte-cap`.
 * @param maxChars - the byte-cap budget in UTF-8 bytes.
 * @returns the canonical value, or its truncation envelope.
 */
export function applyExitPolicy<T>(value: T, policy: 'byte-cap', maxChars: number): T | OutputTruncationEnvelope

export function applyExitPolicy(value: unknown, policy: ExitPolicy, maxChars = 0): unknown {
  if (policy === 'passthrough') return value
  // Lossless-JSON roots always serialize; direct callers passing bare
  // undefined degenerate to an empty serialization (truncating to nothing).
  const serialized = JSON.stringify(value) as string | undefined
  const text = serialized ?? ''
  if (Buffer.byteLength(text, 'utf8') <= maxChars) return value
  const previewBudget = Math.max(0, maxChars - TRUNCATION_ENVELOPE_RESERVE_BYTES)
  const preview = utf8SafePrefix(text, previewBudget)
  const partial = safeJsonPrefixParse(preview)
  const envelope: OutputTruncationEnvelope = {
    _truncated: true,
    _original_chars: Buffer.byteLength(text, 'utf8'),
    _max_chars: maxChars,
    partial,
  }
  return envelope
}
