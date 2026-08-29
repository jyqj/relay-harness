import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@relay-harness/cordis-plugin-include'

function rows(path: string): Array<{ id: string; name: string }> {
  const patch = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema }) as Array<{ insert?: Array<{ id: string; name: string }> }>
  return patch.flatMap(item => item.insert ?? [])
}

describe('default extension product composition', () => {
  it('ships MCP catalog plus shared Web/Desktop MCP and Skill management surfaces', () => {
    expect(rows(resolve('packages/bundle/base/cordis.patch.yml')))
      .toContainEqual(expect.objectContaining({ id: 'mcp-catalog', name: '@relay-harness/rlh-mcp-catalog' }))
    const web = rows(resolve('packages/bundle/web-app/cordis.patch.yml'))
    for (const expected of [
      { id: 'mcp-servers', name: '@relay-harness/rlh-host-mcp-servers' },
      { id: 'skill-inventory', name: '@relay-harness/rlh-host-skill-inventory' },
      { id: 'ui-settings-mcp', name: '@relay-harness/rlh-client-ui-settings-mcp' },
      { id: 'ui-settings-skills', name: '@relay-harness/rlh-client-ui-settings-skills' },
    ]) expect(web).toContainEqual(expect.objectContaining(expected))
    expect(readFileSync(resolve('apps/desktop/src/main/plugins.js'), 'utf8'))
      .toContain("'@relay-harness/rlh-web-app'")
  })
})
