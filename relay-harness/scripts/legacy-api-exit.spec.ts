import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectExitViolations,
  computeDuplicatedDomains,
  DUPLICATED_DOMAIN_ALLOWLIST,
  evaluateExitState,
  extractPrivilegedMethods,
  extractRemoteImports,
  extractRpcMethodKeys,
  EXPECTED_PRIVILEGED_METHODS,
  REMOTE_WIRE_TABLE,
} from './legacy-api-exit.ts'

const harnessRoot = new URL('..', import.meta.url).pathname

describe('legacy API exit guard', () => {
  it('finds the working tree exactly at the ADR-0007 recorded state', () => {
    expect(collectExitViolations(harnessRoot)).toEqual([])
  })

  it('records goals and skills as the only duplicated domains', () => {
    expect(DUPLICATED_DOMAIN_ALLOWLIST.map(entry => entry.domain)).toEqual(['goals', 'skills'])
    expect(computeDuplicatedDomains(liveState().remoteImports, liveState().wireMethods).map(entry => entry.domain))
      .toEqual(['goals', 'skills'])
  })

  it('tables every remote contribution the client assembly imports', () => {
    const tabledImports = REMOTE_WIRE_TABLE.map(entry => entry.remoteImport)
    expect(new Set(tabledImports).size).toBe(tabledImports.length)
    expect(tabledImports).toEqual(liveState().remoteImports)
  })

  it('computes duplication only when both surfaces exist', () => {
    const remotes = ['@relay-harness/rlh-goal/remote', '@relay-harness/rlh-host-mcp-servers/remote']
    const wire = ['goal.create', 'session.list', 'mcpServers/list']
    expect(computeDuplicatedDomains(remotes, wire).map(entry => entry.domain)).toEqual(['goals'])
  })

  it('rejects a duplication that is not allowlisted', () => {
    const violations = evaluateExitState(liveState()).map(v => v.replace(/^domain /, 'domain '))
    expect(violations).toEqual([])
    const withNewDuplication = evaluateExitState({
      ...liveState(),
      wireMethods: [...liveState().wireMethods, 'memoryCenter.read'],
    })
    expect(withNewDuplication.some(v => v.includes('memoryCenter') && v.includes('not allowlisted'))).toBe(true)
  })

  it('rejects a stale allowlist entry whose surfaces are gone', () => {
    const inputs = liveState()
    const migrated: typeof inputs = {
      remoteImports: inputs.remoteImports.filter(specifier => specifier !== '@relay-harness/rlh-goal/remote'),
      wireMethods: inputs.wireMethods.filter(method => !method.startsWith('goal.')),
      privilegedMethods: inputs.privilegedMethods,
    }
    const violations = evaluateExitState(migrated)
    expect(violations.filter(v => v.includes('goals'))).toEqual([
      'allowlist domain goals: remote @relay-harness/rlh-goal/remote is no longer mounted; remove the entry (domain migrated)',
    ])
  })

  it('rejects browser-fence drift in either direction', () => {
    const dropped = evaluateExitState({
      ...liveState(),
      privilegedMethods: liveState().privilegedMethods.filter(method => method !== 'workResults/accept'),
    })
    expect(dropped.some(v => v.includes('PRIVILEGED_METHODS drift') && v.includes('missing: workResults/accept'))).toBe(true)
    const added = evaluateExitState({
      ...liveState(),
      privilegedMethods: [...liveState().privilegedMethods, 'goals/create'],
    })
    expect(added.some(v => v.includes('PRIVILEGED_METHODS drift') && v.includes('unexpected: goals/create'))).toBe(true)
    expect(EXPECTED_PRIVILEGED_METHODS).not.toContain('goals/create')
  })

  it('extractors reject mutated sources', () => {
    const source = [
      'import goalsRemote from \'@relay-harness/rlh-goal/remote\'',
      'import { other } from \'./sibling.ts\'',
      'const PRIVILEGED_METHODS = new Set([',
      "  'host.openPath',",
      '  // \'settings.update\', commented out',
      '])',
    ].join('\n')
    expect(extractRemoteImports(source)).toEqual(['@relay-harness/rlh-goal/remote'])
    expect(extractRpcMethodKeys(source)).toEqual([])
    expect(extractPrivilegedMethods(source)).toEqual(['host.openPath'])
    expect(extractPrivilegedMethods('const PRIVILEGED_METHODS = new Set()')).toEqual([])
  })

  it('extracts remote imports across default, named, aliased, and combined spellings', () => {
    const source = [
      'import goalsRemote from \'@relay-harness/rlh-goal/remote\'',
      'import { default as skills } from \'@relay-harness/rlh-host-skill-inventory/remote\'',
      'import { goals as aliased } from \'@relay-harness/rlh-goal/remote\'',
      'import workResults, { inspect } from \'@relay-harness/rlh-host-work-results/remote\'',
      'import * as namespace from \'@relay-harness/rlh-goal/remote\'',
      'import type { GoalsRemote } from \'@relay-harness/rlh-goal/remote\'',
      'export { carried } from \'@relay-harness/rlh-goal/remote\'',
      'import plain from \'@relay-harness/rlh-goal\'',
    ].join('\n')
    expect(extractRemoteImports(source)).toEqual([
      '@relay-harness/rlh-goal/remote',
      '@relay-harness/rlh-host-skill-inventory/remote',
      '@relay-harness/rlh-goal/remote',
      '@relay-harness/rlh-host-work-results/remote',
      '@relay-harness/rlh-goal/remote',
    ])
  })

  it('extracts wire keys with digits and underscores', () => {
    expect(extractRpcMethodKeys([
      'export interface RpcMethodMap {',
      "  'goal_v2.create': GoalsApi['create']",
      "  'mcpServers/list_v1': McpApi['list']",
      '}',
    ].join('\n'))).toEqual(['goal_v2.create', 'mcpServers/list_v1'])
  })

  it('fails the allowlist check when an allowlisted wire key survives only inside a comment', () => {
    const lineCommented = [
      'export interface RpcMethodMap {',
      "  'session.list': SessionsApi['list']",
      "  // 'goal.create': GoalsApi['create'] — commented out during the migration",
      '}',
    ].join('\n')
    const blockCommented = [
      'export interface RpcMethodMap {',
      '/*',
      "  'goal.create': GoalsApi['create']",
      '*/',
      "  'skill.read': SkillsApi['read']",
      '}',
    ].join('\n')
    for (const source of [lineCommented, blockCommented]) {
      expect(extractRpcMethodKeys(source)).not.toContain('goal.create')
      const violations = evaluateExitState({
        remoteImports: ['@relay-harness/rlh-goal/remote'],
        wireMethods: extractRpcMethodKeys(source),
        privilegedMethods: EXPECTED_PRIVILEGED_METHODS,
      })
      expect(violations).toContainEqual(
        'allowlist domain goals: no apiproxy wire methods remain; remove the entry (domain migrated)')
    }
  })
})

function liveState(): { remoteImports: string[]; wireMethods: string[]; privilegedMethods: readonly string[] } {
  return {
    remoteImports: extractRemoteImports(readFileSync(resolve(harnessRoot, 'packages/api/remotes/src/client/index.ts'), 'utf8')),
    wireMethods: extractRpcMethodKeys(readFileSync(resolve(harnessRoot, 'packages/host/apiproxy/src/api/rpc-map.ts'), 'utf8')),
    privilegedMethods: EXPECTED_PRIVILEGED_METHODS,
  }
}
