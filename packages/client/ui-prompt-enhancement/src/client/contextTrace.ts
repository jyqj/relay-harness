/** Safe browser projection of the opaque Prompt Enhancement Context Engine trace. */

import type { PromptEnhancementResult } from '@relay-harness/rlh-api-remotes/client'

/** Product-level source families shown beside an enhancement proposal. */
export type PromptEnhancementSourceKind = 'file' | 'code' | 'memory' | 'history' | 'mcp'
type PromptEnhancementFreshness = 'current' | 'possibly-stale' | 'stale' | 'unknown'
type PromptEnhancementVerification =
  | 'verified'
  | 'partially-verified'
  | 'unverified'
  | 'contradicted'
  | 'unavailable'

/** One Context Engine evidence record admitted to the enhancement request. */
export interface PromptEnhancementSource {
  readonly kind: PromptEnhancementSourceKind
  readonly key: string
  readonly why: readonly string[]
  readonly freshness: PromptEnhancementFreshness
  readonly verification: PromptEnhancementVerification
}

const MAX_SOURCES = 24
const SOURCE_KINDS = new Set<PromptEnhancementSourceKind>(['file', 'code', 'memory', 'history', 'mcp'])
const FRESHNESS = new Set<PromptEnhancementFreshness>(['current', 'possibly-stale', 'stale', 'unknown'])
const VERIFICATION = new Set<PromptEnhancementVerification>([
  'verified', 'partially-verified', 'unverified', 'contradicted', 'unavailable',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function strings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim() !== '') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 8)
}

function sourceKind(sourceId: string, contributorId: string): PromptEnhancementSourceKind | undefined {
  const identity = `${sourceId} ${contributorId}`.toLowerCase()
  if (sourceId.startsWith('mcp:') || identity.includes('mcp')) return 'mcp'
  if (identity.includes('session-history') || identity.includes('history')) return 'history'
  if (identity.includes('long-term-memory') || identity.includes('memory')) return 'memory'
  if (identity.includes('code-index') || identity.includes('code-context')) return 'code'
  if (identity.includes('file-reference') || identity.includes('workspace-file')) return 'file'
  return undefined
}

function whyOf(domain: Record<string, unknown> | undefined, contributorId: string): readonly string[] {
  const candidates = [
    domain?.['selectionReason'],
    domain?.['selectionReasons'],
    domain?.['reasons'],
    domain?.['matchedBy'],
  ]
  for (const candidate of candidates) {
    const reasons = strings(candidate)
    if (reasons.length > 0) return reasons
  }
  return [`selected by ${contributorId}`]
}

function keyOf(resource: Record<string, unknown>, domain: Record<string, unknown> | undefined): string | undefined {
  if (typeof domain?.['filePath'] === 'string' && domain['filePath'].trim() !== '') return domain['filePath']
  if (typeof domain?.['serverName'] === 'string' && domain['serverName'].trim() !== '') {
    const resourceKey = typeof resource['key'] === 'string' ? resource['key'] : ''
    return resourceKey === '' ? domain['serverName'] : `${domain['serverName']} · ${resourceKey}`
  }
  return typeof resource['key'] === 'string' && resource['key'].trim() !== '' ? resource['key'] : undefined
}

/**
 * Read only the documented contribution/Evidence fields from an opaque Remote trace.
 * Unknown contributors and malformed records stay hidden rather than acquiring a guessed label.
 * @param trace - optional Context Engine trace returned with an enhancement result.
 * @returns bounded, display-safe evidence records in Context Engine order.
 */
export function promptEnhancementSources(
  trace: PromptEnhancementResult['contextTrace'],
): readonly PromptEnhancementSource[] {
  const root = record(trace)
  const contributions = root?.['contributions']
  if (!Array.isArray(contributions)) return []
  const sources: PromptEnhancementSource[] = []
  for (const rawContribution of contributions) {
    const contribution = record(rawContribution)
    const contributorId = contribution?.['contributorId']
    const evidence = contribution?.['evidence']
    if (typeof contributorId !== 'string' || !Array.isArray(evidence)) continue
    for (const rawEvidence of evidence) {
      const item = record(rawEvidence)
      const resource = record(item?.['resource'])
      const sourceId = resource?.['sourceId']
      const freshness = item?.['freshness']
      const verification = item?.['verification']
      if (
        typeof sourceId !== 'string'
        || typeof freshness !== 'string'
        || typeof verification !== 'string'
        || !FRESHNESS.has(freshness as PromptEnhancementFreshness)
        || !VERIFICATION.has(verification as PromptEnhancementVerification)
      ) continue
      const kind = sourceKind(sourceId, contributorId)
      const domain = record(item?.['domain'])
      const key = resource === undefined ? undefined : keyOf(resource, domain)
      if (kind === undefined || key === undefined || !SOURCE_KINDS.has(kind)) continue
      sources.push({
        kind,
        key,
        why: whyOf(domain, contributorId),
        freshness: freshness as PromptEnhancementFreshness,
        verification: verification as PromptEnhancementVerification,
      })
      if (sources.length === MAX_SOURCES) return sources
    }
  }
  return sources
}
