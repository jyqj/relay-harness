/**
 * FTS5 query-building and code-aware tokenization helpers.
 *
 * Ported verbatim from the reference implementation (`crates/cc-db/src/fts.rs`);
 * the unit-test vectors of that file are mirrored in `tests/text.spec.ts`.
 *
 * @module @relay-harness/rlh-code-index-search/text
 */

/** Token shape shared by sanitization and overlap scoring: alphanumeric runs, or CJK segments up to 8 chars. */
const FTS_TOKEN_RE = /[A-Za-z0-9_]+|[一-鿿]{1,8}/g

/**
 * Sanitize a user query into FTS5 match syntax: extract the first 12
 * alphanumeric/CJK tokens and join with OR; an input with no tokenizable
 * content yields the neutral empty phrase `""`.
 * @param query - raw caller query text.
 * @returns an FTS5 MATCH expression of up to 12 OR-joined tokens.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = extractFtsTokens(query)
  if (tokens.length === 0) {
    return '""'
  }
  return tokens.join(' OR ')
}

function extractFtsTokens(query: string): string[] {
  const tokens: string[] = []
  for (const match of query.matchAll(FTS_TOKEN_RE)) {
    tokens.push(match[0])
    if (tokens.length >= 12) break
  }
  return tokens
}

/**
 * Expand a code query by splitting camelCase and snake_case tokens so
 * sub-word queries recall multi-part identifiers. Original words stay in
 * place; each newly derived lowercase part is appended once.
 * @param query - query text to expand (whitespace-split words).
 * @returns the space-joined expanded token stream.
 */
export function expandQueryText(query: string): string {
  const tokens: string[] = []
  const pushUnique = (candidate: string): void => {
    if (!tokens.some(existing => existing.toLowerCase() === candidate.toLowerCase())) {
      tokens.push(candidate)
    }
  }
  for (const word of query.split(/\s+/).filter(word => word.length > 0)) {
    tokens.push(word)
    const camelParts = splitCamelCase(word)
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        pushUnique(part.toLowerCase())
      }
    }
    if (word.includes('_')) {
      for (const part of word.split('_')) {
        if (part.length >= 2) {
          pushUnique(part.toLowerCase())
        }
      }
    }
  }
  return tokens.join(' ')
}

/**
 * Split a camelCase or PascalCase identifier at every lower→upper boundary.
 * @param value - identifier to split.
 * @returns the ordered parts; a single-element list when no boundary exists.
 */
export function splitCamelCase(value: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 1; i < value.length; i++) {
    if (isAsciiUpper(value[i]) && isAsciiLower(value[i - 1])) {
      parts.push(value.slice(start, i))
      start = i
    }
  }
  parts.push(value.slice(start))
  return parts
}

function isAsciiUpper(char: string | undefined): boolean {
  return char !== undefined && char >= 'A' && char <= 'Z'
}

function isAsciiLower(char: string | undefined): boolean {
  return char !== undefined && char >= 'a' && char <= 'z'
}

/**
 * Tokenize text in a code-aware way (for overlap scoring): case-folded FTS tokens.
 * @param text - text to tokenize.
 * @returns lowercase alphanumeric/CJK tokens in occurrence order.
 */
export function tokenizeCodeish(text: string): string[] {
  return Array.from(text.matchAll(FTS_TOKEN_RE), match => match[0].toLowerCase())
}

/**
 * Deterministic lexicographic comparison mirroring Rust's derived `Ord` on UTF-16 code units of ASCII ids and paths.
 * @param a - first operand.
 * @param b - second operand.
 * @returns negative when `a < b`, positive when `a > b`, 0 when equal.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
