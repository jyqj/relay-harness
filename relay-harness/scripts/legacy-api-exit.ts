/**
 * Exit-condition guard for legacy API paths ([ADR-0007](../docs/adr/0007-legacy-api-exit-conditions.md)).
 *
 * Two surfaces expose business domains today: the Typert remote assembly
 * (`packages/api/remotes`, mounted as `ctx.remote.<namespace>`) and the API
 * proxy wire map (`packages/host/apiproxy`, `RpcMethodMap` keys under `/api`).
 * A domain served by both is transitional: the allowlist below is the recorded
 * decision of which duplications may exist. Migrating a domain means deleting
 * its losing surface and removing the allowlist entry in the same change —
 * a stale entry fails because its surfaces no longer exist, and a new
 * duplication fails because it is not allowlisted.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** One domain that currently exists on both the remote and the wire surface. */
export interface DuplicatedDomain {
  /** Domain name as used in the ADR-0007 status table. */
  domain: string
  /** `/remote` import of the domain's Typert remote in the api-remotes client assembly. */
  remoteImport: string
  /** `RpcMethodMap` key prefixes of the domain's apiproxy wire methods. */
  wirePrefixes: readonly string[]
}

/**
 * The recorded set of duplicated domains. Removing an entry is part of that
 * domain's migration; adding one requires an ADR-0007 status row.
 */
export const DUPLICATED_DOMAIN_ALLOWLIST: readonly DuplicatedDomain[] = [
  {
    domain: 'goals',
    remoteImport: '@relay-harness/rlh-goal/remote',
    wirePrefixes: ['goal.'],
  },
  {
    domain: 'skills',
    remoteImport: '@relay-harness/rlh-host-skill-inventory/remote',
    wirePrefixes: ['skill.'],
  },
]

/**
 * Every remote contribution the client assembly may mount, mapped to the wire
 * prefixes of a would-be apiproxy counterpart. `wirePrefixes` is non-empty
 * exactly where an apiproxy handler may legitimately appear: today only the
 * goals and skills entries match live wire methods, and any other match means
 * a new duplication that must join the allowlist or be refused.
 */
export const REMOTE_WIRE_TABLE: readonly DuplicatedDomain[] = [
  { domain: 'commands', remoteImport: '@relay-harness/rlh-commands/remote', wirePrefixes: ['commands.'] },
  { domain: 'goals', remoteImport: '@relay-harness/rlh-goal/remote', wirePrefixes: ['goal.'] },
  { domain: 'issueOrchestration', remoteImport: '@relay-harness/rlh-issue-orchestrator/remote', wirePrefixes: ['issueOrchestration.'] },
  { domain: 'cordisHostRunner', remoteImport: '@relay-harness/rlh-cordis-host-runner/remote', wirePrefixes: ['dynamicCordisRunner.'] },
  { domain: 'fileReferences', remoteImport: '@relay-harness/rlh-file-reference/remote', wirePrefixes: ['fileReferences.'] },
  { domain: 'pluginInventory', remoteImport: '@relay-harness/rlh-host-plugin-inventory/remote', wirePrefixes: ['pluginInventory.'] },
  { domain: 'mcpServers', remoteImport: '@relay-harness/rlh-host-mcp-servers/remote', wirePrefixes: ['mcpServers.'] },
  { domain: 'skills', remoteImport: '@relay-harness/rlh-host-skill-inventory/remote', wirePrefixes: ['skill.'] },
  { domain: 'memoryCenter', remoteImport: '@relay-harness/rlh-host-memory-center/remote', wirePrefixes: ['memoryCenter.'] },
  { domain: 'codeIndexCenter', remoteImport: '@relay-harness/rlh-host-code-index-center/remote', wirePrefixes: ['codeIndexCenter.'] },
  { domain: 'productMode', remoteImport: '@relay-harness/rlh-host-product-mode/remote', wirePrefixes: ['productMode.'] },
  { domain: 'workResults', remoteImport: '@relay-harness/rlh-host-work-results/remote', wirePrefixes: ['workResults.'] },
  { domain: 'messageFeedback', remoteImport: '@relay-harness/rlh-message-feedback/remote', wirePrefixes: ['messageFeedback.'] },
  { domain: 'promptEnhancement', remoteImport: '@relay-harness/rlh-prompt-enhancement/remote', wirePrefixes: ['promptEnhancement.'] },
  { domain: 'sessionReferences', remoteImport: '@relay-harness/rlh-session-reference/remote', wirePrefixes: ['sessionReferenceResolver.'] },
]

/**
 * The methods the browser-trust fence in `packages/client/connection` pins to
 * loopback. The fence is a transitional re-exposure: remote-tunnel groups
 * (`mcpServers/*`, `skillInventory/*`, `workResults/*`) shrink when their
 * domain consolidates, so the list is pinned here verbatim.
 */
export const EXPECTED_PRIVILEGED_METHODS: readonly string[] = [
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
  'mcpServers/list',
  'mcpServers/upsert',
  'mcpServers/delete',
  'mcpServers/setEnabled',
  'mcpServers/retry',
  'mcpServers/authorize',
  'skillInventory/list',
  'skillInventory/get',
  'skillInventory/create',
  'skillInventory/update',
  'skillInventory/delete',
  'skillInventory/setInvocation',
  'workResults/get',
  'workResults/review',
  'workResults/inspect',
  'workResults/history',
  'workResults/accept',
  'workResults/list',
  'workResults/open',
]

/**
 * Reads the `/remote` import specifiers of a client-assembly source.
 * @param source - Full text of the module (typically api-remotes `client/index.ts`).
 * @returns Every `@relay-harness/.../remote` specifier of a runtime import —
 * default, named, aliased, and default-plus-named spellings — in file order;
 * `import type` declarations and type-only re-exports are ignored.
 */
export function extractRemoteImports(source: string): string[] {
  return [...source.matchAll(/^import (?!type\b)[\w${}, *]+?from '(@relay-harness\/[^']+\/remote)'$/gm)]
    .map(match => match[1] ?? '')
}

/**
 * Reads the wire method keys of an `RpcMethodMap` source file.
 * @param source - Full text of the map module (typically apiproxy `api/rpc-map.ts`).
 * @returns Every quoted `segment.method` key declared in the map, in file
 * order. Comments are stripped first, so a key that only survives inside a
 * comment is not extracted.
 */
export function extractRpcMethodKeys(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...stripped.matchAll(/'([a-zA-Z0-9_$]+(?:\/[a-zA-Z0-9_$]+|\.[a-zA-Z0-9_$]+))':/g)].map(match => match[1] ?? '')
}

/**
 * Reads the method names pinned by the browser-trust fence.
 * @param source - Full text of the connection module declaring `PRIVILEGED_METHODS`.
 * @returns Every string literal inside the `PRIVILEGED_METHODS` set literal, in file order.
 */
export function extractPrivilegedMethods(source: string): string[] {
  const setStart = source.indexOf('PRIVILEGED_METHODS = new Set([')
  if (setStart < 0) return []
  const listStart = source.indexOf('[', setStart)
  const listEnd = source.indexOf('])', listStart)
  if (listStart < 0 || listEnd < 0) return []
  // Comments inside the literal carry prose apostrophes that would otherwise
  // be read as string delimiters; strip them before matching literals.
  const literal = source.slice(listStart, listEnd).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...literal.matchAll(/'([^']+)'/g)].map(match => match[1] ?? '')
}

/**
 * Computes the domains that currently exist on both surfaces: the remote
 * contribution is mounted by the client assembly and an apiproxy wire method
 * matches one of the domain's prefixes.
 * @param remoteImports - Remote specifiers mounted by the client assembly.
 * @param wireMethods - `RpcMethodMap` keys of the apiproxy surface.
 * @returns Duplicated domains per {@link REMOTE_WIRE_TABLE}, sorted by domain name.
 */
export function computeDuplicatedDomains(remoteImports: readonly string[], wireMethods: readonly string[]): DuplicatedDomain[] {
  return REMOTE_WIRE_TABLE
    .filter(entry => remoteImports.includes(entry.remoteImport)
      && wireMethods.some(method => entry.wirePrefixes.some(prefix => method.startsWith(prefix))))
    .sort((a, b) => a.domain.localeCompare(b.domain))
}

/**
 * Checks one guarded source file against its expected content.
 * @param actual - Values extracted from the live source.
 * @param expected - Values the ADR-0007 decision records.
 * @returns A violation message, or `undefined` when the sides agree.
 */
function expectSameSet(actual: readonly string[], expected: readonly string[]): string | undefined {
  const actualSorted = [...actual].sort()
  const expectedSorted = [...expected].sort()
  const missing = expectedSorted.filter(value => !actualSorted.includes(value))
  const unexpected = actualSorted.filter(value => !expectedSorted.includes(value))
  if (missing.length === 0 && unexpected.length === 0) return undefined
  return `expected [${expectedSorted.join(', ')}] but found [${actualSorted.join(', ')}]` +
    (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
    (unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : '')
}

/** Source facts the exit assertions evaluate, as extracted from the live tree. */
export interface ExitStateInputs {
  /** Remote specifiers mounted by the api-remotes client assembly. */
  remoteImports: readonly string[]
  /** `RpcMethodMap` keys of the apiproxy surface. */
  wireMethods: readonly string[]
  /** Methods pinned by the browser-trust fence. */
  privilegedMethods: readonly string[]
}

/**
 * Evaluates every ADR-0007 exit-condition assertion against extracted source facts.
 * @param inputs - The extracted remote, wire, and fence state.
 * @returns One violation message per failed assertion; empty when the state matches the recorded decision.
 */
export function evaluateExitState(inputs: ExitStateInputs): string[] {
  const { remoteImports, wireMethods, privilegedMethods } = inputs
  const violations: string[] = []

  const untabled = remoteImports.filter(imported => !REMOTE_WIRE_TABLE.some(entry => entry.remoteImport === imported))
  if (untabled.length > 0) {
    violations.push(`remote contributions missing from REMOTE_WIRE_TABLE: ${untabled.join(', ')}`)
  }
  const computed = computeDuplicatedDomains(remoteImports, wireMethods)
  const allowlisted = [...DUPLICATED_DOMAIN_ALLOWLIST].sort((a, b) => a.domain.localeCompare(b.domain))
  const computedDomains = computed.map(entry => entry.domain)
  const allowlistedDomains = allowlisted.map(entry => entry.domain)
  for (const domain of computedDomains.filter(name => !allowlistedDomains.includes(name))) {
    violations.push(`domain ${domain} is duplicated across api/remotes and apiproxy but not allowlisted`)
  }
  for (const entry of allowlisted) {
    if (!remoteImports.includes(entry.remoteImport)) {
      violations.push(`allowlist domain ${entry.domain}: remote ${entry.remoteImport} is no longer mounted; remove the entry (domain migrated)`)
      continue
    }
    const surviving = entry.wirePrefixes.filter(prefix => wireMethods.some(method => method.startsWith(prefix)))
    if (surviving.length === 0) {
      violations.push(`allowlist domain ${entry.domain}: no apiproxy wire methods remain; remove the entry (domain migrated)`)
    }
  }

  const privilegedViolation = expectSameSet(privilegedMethods, EXPECTED_PRIVILEGED_METHODS)
  if (privilegedViolation !== undefined) {
    violations.push(`PRIVILEGED_METHODS drift: ${privilegedViolation}`)
  }
  return violations
}

/**
 * Reads the working tree and runs every ADR-0007 exit-condition assertion.
 * @param harnessRoot - The `relay-harness/` workspace root containing `packages/`.
 * @returns One violation message per failed assertion; empty when the tree matches the recorded state.
 */
export function collectExitViolations(harnessRoot: string): string[] {
  const remotesSource = readFileSync(resolve(harnessRoot, 'packages/api/remotes/src/client/index.ts'), 'utf8')
  const rpcMapSource = readFileSync(resolve(harnessRoot, 'packages/host/apiproxy/src/api/rpc-map.ts'), 'utf8')
  const connectionSource = readFileSync(resolve(harnessRoot, 'packages/client/connection/src/index.ts'), 'utf8')
  return evaluateExitState({
    remoteImports: extractRemoteImports(remotesSource),
    wireMethods: extractRpcMethodKeys(rpcMapSource),
    privilegedMethods: extractPrivilegedMethods(connectionSource),
  })
}
