import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@relay-harness/cordis-plugin-include'

function rows(path: string) {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema }) as Array<{
    insert?: Array<{ id: string; name: string; config?: unknown }>
  }>
  return parsed.flatMap(item => item.insert ?? [])
}

describe('default Prompt Enhancement source closure', () => {
  it('composes history, files, code, memory, and MCP Resource contributors through one Context Engine', () => {
    const base = rows(resolve('packages/bundle/base/cordis.patch.yml'))
    const web = rows(resolve('packages/bundle/web-app/cordis.patch.yml'))
    for (const expected of [
      { id: 'session-history-context', name: '@relay-harness/rlh-session-history-context' },
      { id: 'memory-agent', name: '@relay-harness/rlh-memory-agent' },
      { id: 'mcp-catalog', name: '@relay-harness/rlh-mcp-catalog' },
    ]) expect(base).toContainEqual(expect.objectContaining(expected))
    for (const expected of [
      { id: 'prompt-enhancement-context', name: '@relay-harness/rlh-prompt-enhancement-context-engine' },
      { id: 'file-reference-local', name: '@relay-harness/rlh-file-reference-local' },
      { id: 'code-context', name: '@relay-harness/rlh-code-context' },
    ]) expect(web).toContainEqual(expect.objectContaining(expected))
    const fileConfig = web.find(row => row.id === 'file-reference-local')?.config
    expect(fileConfig).toBeTypeOf('object')
    expect(fileConfig).toHaveProperty('fileContent')
  })
})
