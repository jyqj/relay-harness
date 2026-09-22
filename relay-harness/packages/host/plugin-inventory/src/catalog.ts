/**
 * The shipped effective-capability catalog: which deployment-relevant
 * capabilities the report joins, which composed bundle entries assemble them,
 * which config they need, and which model-facing tools put them in a session's
 * toolset. Requirement predicates read the composed config as written, so a
 * boot-free dump evaluates literal values and reports unevaluated `!!js`
 * expressions as unmet rather than guessing.
 * @module @relay-harness/rlh-host-plugin-inventory/catalog
 */

import type { CapabilityConfigRequirement, CapabilityDefinition } from './types.ts'

/** Read the value at a dotted config path, or undefined when any hop is missing. */
function readConfigPath(config: unknown, path: readonly string[]): unknown {
  let current: unknown = config
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Whether a composed config value is a non-empty string as written. */
function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The vector lane of the local code index is off unless the embedding section
 * names a non-empty `baseURL` and `model` (the documented off switch of
 * `resolveEmbeddingConfig`); lexical search continues without it.
 */
const embeddingEndpointRequirement: CapabilityConfigRequirement = {
  description: 'embedding endpoint configured (config.embedding.baseURL and config.embedding.model non-empty); omitting either removes the vector lane, leaving lexical search only',
  entryId: 'code-index-workspace-router',
  satisfied: (config: unknown): boolean => {
    const baseURL = readConfigPath(config, ['embedding', 'baseURL'])
    const model = readConfigPath(config, ['embedding', 'model'])
    return isNonEmptyString(baseURL) && isNonEmptyString(model)
  },
}

const webSearchKeyRequirement: CapabilityConfigRequirement = {
  description: 'DeepSeek API key source configured (config.apiKeyEnv non-empty)',
  entryId: 'web-search-deepseek',
  satisfied: (config: unknown): boolean => isNonEmptyString(readConfigPath(config, ['apiKeyEnv'])),
}

/**
 * `openAt: 'never'` keeps the SQLite session index closed: search calls fail
 * with SESSION_QUERY_SEARCH_DISABLED while exact reads stay available.
 */
const sessionSearchOpenRequirement: CapabilityConfigRequirement = {
  description: "session index opens on demand (config.openAt is 'first-search' or 'startup', not the shipped default 'never', which fails search calls with SESSION_QUERY_SEARCH_DISABLED)",
  entryId: 'session-query-sqlite',
  satisfied: (config: unknown): boolean => readConfigPath(config, ['openAt']) !== 'never',
}

/** Capabilities the shipped report joins, in report order. */
export const DEFAULT_CAPABILITY_CATALOG: readonly CapabilityDefinition[] = [
  {
    id: 'code-index',
    label: 'Local code index (workspace knowledge and semantic search)',
    entryIds: ['code-index-workspace-router'],
    requirements: [embeddingEndpointRequirement],
    toolNames: ['search_code_index'],
  },
  {
    id: 'web-search',
    label: 'Web search',
    entryIds: ['web-search-deepseek', 'tool-web'],
    requirements: [webSearchKeyRequirement],
    toolNames: ['web_search'],
  },
  {
    id: 'session-full-text-search',
    label: 'Full-text session search',
    entryIds: ['session-query-sqlite'],
    requirements: [sessionSearchOpenRequirement],
    toolNames: ['session_search'],
  },
]
