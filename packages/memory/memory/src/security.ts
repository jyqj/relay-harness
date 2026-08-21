/** Shared conservative secret detection for memory admission and extraction. */

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*[^\s]{8,}/iu,
]

/**
 * Detect common credential forms that must not be copied into memory storage.
 * @param content - candidate source or memory content.
 * @returns whether the text matches a blocked credential form.
 */
export function memoryContainsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(content))
}
