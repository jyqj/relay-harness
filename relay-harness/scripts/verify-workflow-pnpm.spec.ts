import { describe, expect, it } from 'vitest'
import { verifyPnpmSetupPaths } from './verify-workflow-pnpm.mjs'

const prefix = 'jobs:\n  tests:\n    steps:\n'
const step = "      - uses: pnpm/action-setup@v4\n        with:\n          package_json_file: relay-harness/package.json\n"

describe('action-owned pnpm manifest paths', () => {
  it('accepts block inputs and checks every step', () => {
    expect(verifyPnpmSetupPaths(prefix + step + step, 'ci.yml')).toBe(2)
  })
  it.each(['"relay-harness/package.json"', "'relay-harness/package.json'"])('accepts quoted manifest paths (%s)', (path) => {
    expect(verifyPnpmSetupPaths(prefix + step.replace('relay-harness/package.json', path), 'ci.yml')).toBe(1)
  })
  it('accepts named steps and ignores commented out setup actions', () => {
    const named = step.replace('- uses:', '- name: Set up pnpm\n        uses:')
    expect(verifyPnpmSetupPaths(prefix + '      # - uses: pnpm/action-setup@v4\n' + named, 'ci.yml')).toBe(1)
  })
  it.each([
    "      - uses: pnpm/action-setup@v4\n",
    "      - uses: pnpm/action-setup@v4\n        with:\n          version: '11.22.0'\n",
    step.replace('relay-harness/package.json', 'package.json'),
    step.replace('with:', 'env:'),
    "      - uses: pnpm/action-setup@v4\n        with: { package_json_file: relay-harness/package.json }\n",
  ])('rejects missing, misplaced, inline, and repository-root manifests', (invalid) => {
    expect(() => verifyPnpmSetupPaths(prefix + invalid, 'ci.yml')).toThrow('with.package_json_file')
  })
  it('does not borrow another step or shell defaults to supply the setup input', () => {
    const text = 'defaults:\n  run:\n    working-directory: relay-harness\n' + prefix
      + '      - uses: pnpm/action-setup@v4\n'
      + '      - uses: actions/setup-node@v6\n        with:\n          package_json_file: relay-harness/package.json\n'
    expect(() => verifyPnpmSetupPaths(text, 'ci.yml')).toThrow('pnpm setup requires')
  })
  it('reports zero for a workflow without pnpm setup', () => {
    expect(verifyPnpmSetupPaths(prefix + '      - run: echo ready\n', 'other.yml')).toBe(0)
  })
})
