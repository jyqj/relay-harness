/**
 * Search planning — normalizes caller requests into a compact execution plan.
 *
 * Ported from the reference implementation (`crates/cc-search/src/plan.rs`),
 * reduced to the harness seam vocabulary: no conversation-query augmentation.
 * The DSL parses the reference's four filter keys (`dsl.rs::parse_search_dsl`):
 * `path:` fills the path prefix, `lang:` becomes the stored-language scope the
 * store enforces in SQL, `kind:` / `name:` act at finalization against the
 * candidate's symbol columns. The engine owns execution (lane queries, fusion,
 * fetch); the plan owns the caller-facing semantics that stay consistent
 * across those steps: query normalization, top-K/prefix normalization, lane
 * limits, materialized filters, preselect wiring (including recentPaths), and
 * result finalization.
 *
 * @module @relay-harness/rlh-code-index-search/plan
 */

import { repoSizeTierSearchTopK, type RepoSizeTier } from '@relay-harness/rlh-code-index'
import type { ChunkScope, RetrievalPort } from './port.ts'
import { preselect } from './preselect.layers.ts'
import { compareStrings, expandQueryText, tokenizeCodeish } from './text.ts'

export { compareStrings }
import type {
  EngineSearchRequest,
  LaneOutcome,
  LaneRankedHit,
  LaneStats,
  PreselectLayer,
  PreselectResult,
  RankingConfig,
  SearchConfig,
} from './types.ts'

/** Per-lane candidate caps and the post-fusion window. */
export interface LaneLimits {
  readonly topK: number
  readonly lexical: number
  readonly grep: number
  readonly graph: number
  readonly literal: number
  readonly vector: number
  readonly rerankWindow: number
}

/** Narrow, read-only plan surface handed to lanes through their context. */
export interface SearchPlanView {
  /** Expanded query text feeding the lexical lane. */
  lexicalQuery(): string
  /** Raw caller query feeding the grep lane. */
  grepQuery(): string
  /** Case-folded code tokens of the trimmed query (overlap scoring, graph seeding). */
  queryTokens(): readonly string[]
  limits(): LaneLimits
  chunkScope(): ChunkScope
  passesFilters(filePath: string): boolean
  hasFileScope(): boolean
  /** The normalized caller request (per-request gates like `includeGrep` read here). */
  readonly request: EngineSearchRequest
}

/** Materialized in-memory filters mirrored onto {@link ChunkScope}. */
export interface MaterializedFilters {
  readonly pathPrefix: string | null
  /** Stored language names candidates must match; `null` leaves language unrestricted. */
  readonly languages: readonly string[] | null
  readonly filePaths: readonly string[] | null
  /** Symbol-kind strings finalization retains; `null` retains everything. */
  readonly kinds: readonly string[] | null
  /** Symbol-name substring `name:` finalization boosts and retains on; `null` retains everything. */
  readonly name: string | null
}

/** The parsed DSL filters of one query (`dsl.rs::ParsedQuery`, narrowed to the harness keys). */
export interface ParsedDslLite {
  readonly text: string
  readonly pathFilter: string | null
  readonly kindFilter: string | null
  readonly langFilter: string | null
  readonly nameFilter: string | null
}

/** Minimum interim shape the finalization stages read (`finalize_results`). */
export interface FinalizableResult {
  readonly score: number
  readonly chunkId: string
  readonly symbolName?: string | null | undefined
  readonly symbolKind?: string | null | undefined
  readonly reasons?: readonly string[] | undefined
}

/** Known filter keys, in the reference `dsl.rs::FILTER_KEYS` order. */
const FILTER_KEYS: readonly string[] = ['kind', 'lang', 'path', 'name']

/**
 * One filter token: a known key + colon, then a quoted string (an unterminated
 * value consumes to the end of the query, like the reference's quote scanner)
 * or a bare non-space run.
 */
const FILTER_TOKEN_RE = new RegExp(`^(${FILTER_KEYS.join('|')}):(?:"([^"]*)"|"(.*)$|(\\S*))`, 'i')

/**
 * Extract the DSL filter keys (`kind:` / `lang:` / `path:` / `name:`; quoted or
 * bare values, keys case-insensitive) from a query — `dsl.rs::parse_search_dsl`.
 * Keys with an empty value are consumed but unset; unknown `foo:` tokens stay
 * free text. One divergence from the reference: a repeated key keeps its FIRST
 * value (the parser is first-match-wins, like the established `path:` behavior
 * here), where the reference overwrites with the last.
 * @param rawQuery - the raw caller query.
 * @returns free text with every filter token removed, plus the extracted
 * filters (`null` for each absent or empty one).
 */
export function parseDslLite(rawQuery: string): ParsedDslLite {
  const empty: ParsedDslLite = { text: '', pathFilter: null, kindFilter: null, langFilter: null, nameFilter: null }
  const trimmed = rawQuery.trim()
  if (trimmed.length === 0) return empty

  const tokens: string[] = []
  const filters: Record<'kind' | 'lang' | 'path' | 'name', string | null> = {
    kind: null, lang: null, path: null, name: null,
  }
  let position = 0
  while (position < trimmed.length) {
    const rest = trimmed.slice(position)
    const firstChar = rest[0]
    if (firstChar !== undefined && /\s/.test(firstChar)) {
      position++
      continue
    }
    const filterMatch = FILTER_TOKEN_RE.exec(rest)
    if (filterMatch !== null) {
      // Exactly one value group participates: the closed-quoted form may
      // legitimately be empty (consumed, unset), the unterminated-quoted form
      // runs to the end of the query, and the bare form is any non-space run.
      // The key prefix of the whole match always carries the filter key.
      const key = filterMatch[0].slice(0, filterMatch[0].indexOf(':')).toLowerCase() as 'kind' | 'lang' | 'path' | 'name'
      const closedQuoted = filterMatch[2]
      const openQuoted = filterMatch[3]
      const bare = filterMatch[4] === undefined ? '' : filterMatch[4]
      const value = closedQuoted !== undefined ? closedQuoted : openQuoted !== undefined ? openQuoted : bare
      if (value.length > 0 && filters[key] === null) {
        filters[key] = value
      }
      position += filterMatch[0].length
      continue
    }
    const nextSpace = /\s/.exec(rest)
    const token = nextSpace === null ? rest : rest.slice(0, nextSpace.index)
    tokens.push(token)
    position += token.length
  }
  return { text: tokens.join(' '), pathFilter: filters.path, kindFilter: filters.kind, langFilter: filters.lang, nameFilter: filters.name }
}

/**
 * Normalize a symbol-kind filter the way `dsl.rs::matches_kind` does: the
 * filter lowercases with spaces folded to underscores, the stored kind only
 * lowercases, so `'type alias'`, `'Type Alias'`, and `'type_alias'` are one
 * equivalence class.
 * @param symbolKind - the candidate's stored symbol kind.
 * @param kindFilter - the `kind:` value as given.
 * @returns `true` when both normalized forms are equal.
 */
export function matchesKind(symbolKind: string, kindFilter: string): boolean {
  const normalizedFilter = kindFilter.toLowerCase().replaceAll(' ', '_')
  return symbolKind.toLowerCase() === normalizedFilter
}

/**
 * Aliases resolving a `lang:` value onto the stored language names
 * (`cc-model/src/lib.rs` `Language::from_name`, keyed by lowercase input).
 */
const LANGUAGE_NAME_ALIASES: Readonly<Record<string, string>> = {
  python: 'python', py: 'python',
  javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  java: 'java',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  vue: 'vue',
  svelte: 'svelte',
  markdown: 'markdown', md: 'markdown',
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp',
  php: 'php',
  ruby: 'ruby', rb: 'ruby',
  swift: 'swift',
  kotlin: 'kotlin', kt: 'kotlin',
  c: 'c',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp',
  dart: 'dart',
  scala: 'scala', sc: 'scala',
  lua: 'lua', luau: 'lua',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  hcl: 'hcl', terraform: 'hcl', tf: 'hcl',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  protobuf: 'protobuf', proto: 'protobuf',
  graphql: 'graphql', gql: 'graphql',
  cmake: 'cmake',
}

/**
 * Resolve a `lang:` value onto the stored language vocabulary
 * (`Language::from_name`): case-insensitive aliases; `null` when unknown,
 * which leaves the language scope unset instead of filtering everything out.
 * @param value - the `lang:` value as given.
 * @returns the stored language name, or `null` when unrecognized.
 */
export function languageFromName(value: string): string | null {
  return LANGUAGE_NAME_ALIASES[value.toLowerCase()] ?? null
}

/**
 * Resolve the DSL language filter into the scope's stored-name list: `null`
 * stays unrestricted and an unknown name filters nothing (`normalize_request_from_dsl`).
 * @param langFilter - the parsed `lang:` value, or `null`.
 * @returns the one-element scope list, or `null` when unrestricted.
 */
function resolveLanguages(langFilter: string | null): readonly string[] | null {
  if (langFilter === null) return null
  const resolved = languageFromName(langFilter)
  return resolved === null ? null : [resolved]
}

/**
 * Impute a default file-preselect budget scaled by top-K and tier (`default_preselect_limit`: floor 60, multipliers 12/15/20).
 * @param topK - resolved result cap the fold is sized against.
 * @param tier - repository-size class, or `null` when unknown (uses the smallest multiplier).
 * @returns `max(60, topK * multiplier)` with multiplier 12/15/20 by tier.
 */
export function defaultPreselectLimit(topK: number, tier: RepoSizeTier | null): number {
  const multiplier = tier === null || tier === 'tiny' || tier === 'small'
    ? 12
    : tier === 'medium'
      ? 15
      : 20
  return Math.max(60, topK * multiplier)
}

/** Writable shallow copy shape used while normalizing an incoming request. */
type MutableEngineSearchRequest = { -readonly [K in keyof EngineSearchRequest]: EngineSearchRequest[K] }

/** Concrete plan built once per search; implements {@link SearchPlanView} for lanes. */
export class SearchPlan implements SearchPlanView {
  /** The normalized caller request (DSL text merged, path prefix filled). */
  readonly request: EngineSearchRequest
  /** Camel/snake-expanded query feeding the lexical lane. */
  readonly expandedQuery: string
  /** Case-folded code tokens of the trimmed query, for overlap scoring. */
  readonly queryTokensValue: readonly string[]
  /** Resolved lane caps and post-fusion window (each at least the tier top-K). */
  readonly limitsValue: LaneLimits
  /** In-memory prefix/file filters mirrored onto `chunkScope()`. */
  readonly filters: MaterializedFilters
  /** Outcome of the preselect fold (scores, reasons, per-layer bills, stats). */
  readonly preselectResult: PreselectResult
  /** Resolved rerank constants used by every scoring step. */
  readonly ranking: RankingConfig

  private constructor(
    request: EngineSearchRequest,
    expandedQuery: string,
    queryTokens: readonly string[],
    limits: LaneLimits,
    filters: MaterializedFilters,
    preselectResult: PreselectResult,
    ranking: RankingConfig,
  ) {
    this.request = request
    this.expandedQuery = expandedQuery
    this.queryTokensValue = queryTokens
    this.limitsValue = limits
    this.filters = filters
    this.preselectResult = preselectResult
    this.ranking = ranking
  }

  /**
   * Normalize the caller request into a plan: DSL-lite prefix merge, tier-aware
   * top-K, lane limits, and the preselect fold with recentPaths wired into the
   * layer context.
   * @param input - the retrieval port to fold preselect against, the caller
   * request, resolved config/ranking, the repository size tier, and the
   * preselect layer set the fold runs (defaults to the built-in layers).
   * @returns the concrete plan handed to lanes and rerank.
   */
  static build(input: {
    port: RetrievalPort
    request: EngineSearchRequest
    searchConfig: SearchConfig
    ranking: RankingConfig
    /** Resolved repository size tier. */
    tier: RepoSizeTier
    /** Preselect layer set the fold executes; defaults to `defaultPreselectLayers()`. */
    layers?: readonly PreselectLayer[]
  }): SearchPlan {
    const { request, searchConfig, ranking } = input
    const dsl = parseDslLite(request.query)
    // Mirror `normalize_request_from_dsl`: the DSL path filter fills an absent
    // prefix; extracted text replaces the raw query when non-empty.
    const normalizedRequest: MutableEngineSearchRequest = {
      ...request,
      query: dsl.text.length > 0 ? dsl.text : request.query,
    }
    if (normalizedRequest.pathPrefix === undefined && dsl.pathFilter !== null) {
      normalizedRequest.pathPrefix = dsl.pathFilter
    }

    const baseTopK = normalizeTopK(normalizedRequest.topK, input.tier)

    const queryText = normalizedRequest.query.trim()
    const expandedQuery = expandQueryText(queryText)
    const preselectResult = preselect({
      port: input.port,
      query: queryText,
      pathPrefix: normalizedRequest.pathPrefix ?? null,
      boostFilePaths: normalizedRequest.boostFilePaths ?? null,
      recentFilePaths: normalizedRequest.recentPaths ?? null,
      pinnedFilePaths: normalizedRequest.pinnedFilePaths ?? null,
      overlayFilePaths: normalizedRequest.overlayFilePaths ?? null,
      explicitFilePaths: explicitPathsOf(normalizedRequest),
      limit: defaultPreselectLimit(baseTopK, input.tier),
      ranking,
      ...(input.layers === undefined ? {} : { layers: input.layers }),
    })

    // The reference injects preselect files into the explicit scope when the
    // caller gave none. P1 keeps the in-memory/scan scope bound by caller
    // intent instead, so grep scan budgets stay meaningful; recall comes from
    // lane hits fused over all candidates. The DSL language filter fills the
    // language scope, resolved through the stored-language aliases — an
    // unknown name filters nothing, exactly like `Language::from_name`.
    const filters: MaterializedFilters = {
      pathPrefix: normalizedRequest.pathPrefix ?? null,
      languages: resolveLanguages(dsl.langFilter),
      filePaths: explicitPathsOf(normalizedRequest),
      kinds: dsl.kindFilter === null ? null : [dsl.kindFilter],
      name: dsl.nameFilter,
    }
    const limits: LaneLimits = {
      topK: baseTopK,
      lexical: Math.max(searchConfig.lexicalTopK, baseTopK),
      grep: Math.max(searchConfig.grepTopK, baseTopK),
      graph: Math.max(searchConfig.graphTopK, baseTopK),
      literal: Math.max(searchConfig.literalTopK, baseTopK),
      vector: Math.max(searchConfig.vectorTopK, baseTopK),
      rerankWindow: Math.max(searchConfig.rerankWindow, baseTopK),
    }

    return new SearchPlan(
      normalizedRequest,
      expandedQuery,
      tokenizeCodeish(queryText),
      limits,
      filters,
      preselectResult,
      ranking,
    )
  }

  lexicalQuery(): string {
    return this.expandedQuery
  }

  grepQuery(): string {
    return this.request.query
  }

  queryTokens(): readonly string[] {
    return this.queryTokensValue
  }

  limits(): LaneLimits {
    return this.limitsValue
  }

  chunkScope(): ChunkScope {
    return {
      pathPrefix: this.filters.pathPrefix,
      languages: this.filters.languages,
      filePaths: this.filters.filePaths,
    }
  }

  passesFilters(filePath: string): boolean {
    if (this.filters.pathPrefix !== null && !filePath.startsWith(this.filters.pathPrefix)) {
      return false
    }
    const files = this.filters.filePaths
    return files === null || files.includes(filePath)
  }

  hasFileScope(): boolean {
    const files = this.filters.filePaths
    return files !== null && files.length > 0
  }

  /**
   * Rank lookups + annotation order derived from lane outcomes (`LaneRanks::from_outcomes`).
   * @param outcomes - lane outcomes in fusion order.
   * @returns the per-lane rank index consumed by rerank.
   */
  laneRanks(outcomes: readonly LaneOutcome[]): LaneRanks {
    return LaneRanks.fromOutcomes(outcomes)
  }

  /**
   * Apply the DSL retention stages, then sort deterministically (score desc,
   * chunkId asc lexicographic) and cut to `limit` — `finalize_results`. A
   * `kind:` filter retains only candidates whose symbol kind matches
   * (`dsl.rs::matches_kind`; no symbol kind means no retention). A `name:`
   * filter boosts matching symbol names by `ranking.dslNameBonus` with a
   * `dsl-name:{value}` reason, then retains only the matches — the boost and
   * the cut are one stage in the reference too.
   * @param results - interim items carrying `score` and `chunkId`, plus the
   *   optional symbol columns the stages read.
   * @param limit - cut position; defaults to the plan's top-K.
   * @returns a fresh sorted, truncated array (input untouched).
   */
  finalizeResults<T extends FinalizableResult>(results: readonly T[], limit?: number): T[] {
    let working = [...results]
    const kinds = this.filters.kinds
    if (kinds !== null) {
      working = working.filter((item) => {
        const symbolKind = item.symbolKind
        return symbolKind != null && kinds.some(wanted => matchesKind(symbolKind, wanted))
      })
    }
    const nameFilter = this.filters.name
    if (nameFilter !== null) {
      const needle = nameFilter.toLowerCase()
      working = working
        .filter(item => item.symbolName != null && item.symbolName.toLowerCase().includes(needle))
        .map(item => ({
          ...item,
          score: item.score + this.ranking.dslNameBonus,
          reasons: [...(item.reasons ?? []), `dsl-name:${nameFilter}`],
        }))
    }
    return working
      .sort((a, b) =>
        b.score !== a.score ? b.score - a.score : compareStrings(a.chunkId, b.chunkId),
      )
      .slice(0, limit ?? this.limits().topK)
  }
}

/** Per-lane 1-based rank lookups uniformly keyed by lane id, plus annotating order. */
export class LaneRanks {
  private constructor(
    private readonly byLane: Map<string, Map<string, number>>,
    readonly annotatingLanes: ReadonlyArray<{ laneId: string; scoreSlot: string | null }>,
  ) {}

  /**
   * Build the index from lane outcomes: 1-based ranks per lane, plus the
   * annotation order of lanes that opted in.
   * @param outcomes - lane outcomes in fusion order.
   * @returns the constructed rank index.
   */
  static fromOutcomes(outcomes: readonly LaneOutcome[]): LaneRanks {
    const byLane = new Map<string, Map<string, number>>()
    const annotating: Array<{ laneId: string; scoreSlot: string | null }> = []
    for (const outcome of outcomes) {
      if (outcome.annotatesHits) {
        annotating.push({ laneId: outcome.laneId, scoreSlot: outcome.scoreSlot })
      }
      const ranks = new Map<string, number>()
      outcome.hits.forEach((hit: LaneRankedHit, position) => {
        ranks.set(hit.chunkId, position + 1)
      })
      byLane.set(outcome.laneId, ranks)
    }
    return new LaneRanks(byLane, annotating)
  }

  /**
   * Look up a chunk's 1-based rank within one lane.
   * @param laneId - the lane whose ranks to consult.
   * @param chunkId - candidate to rank.
   * @returns 1-based rank, or `undefined` when the lane missed the chunk.
   */
  rank(laneId: string, chunkId: string): number | undefined {
    return this.byLane.get(laneId)?.get(chunkId)
  }
}

/**
 * Lane statistics from this plan's preselect fold (fts/token hit counts, fallback gate).
 * @param plan - the plan whose fold produced the stats.
 * @returns the `LaneStats` carried by that fold.
 */
export function laneStatsOf(plan: SearchPlan): LaneStats {
  return plan.preselectResult.laneStats
}

/** Tier cap via the single-source seam constant table. */
function normalizeTopK(requested: number | undefined, tier: RepoSizeTier): number {
  const tierDefault = repoSizeTierSearchTopK(tier)
  if (requested === undefined || requested <= 0) {
    return tierDefault
  }
  return Math.min(requested, tierDefault)
}

function explicitPathsOf(request: EngineSearchRequest): readonly string[] | null {
  const paths = request.paths
  return paths !== undefined && paths.length > 0 ? [...paths] : null
}
