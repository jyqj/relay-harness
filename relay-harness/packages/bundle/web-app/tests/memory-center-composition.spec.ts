import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@relay-harness/cordis-plugin-include'

describe('Web Memory Center composition', () => {
  it('ships the Host governance Remote and Client Settings surface together', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
      schema: entryListSchema,
    }) as { insert?: { id: string; name: string; config?: Record<string, unknown> }[] }[]
    const rows = parsed.flatMap(item => item.insert ?? [])
    expect(rows.find(row => row.id === 'memory-center')).toMatchObject({
      name: '@relay-harness/rlh-host-memory-center',
      config: { agentId: 'relay-harness', usageConcurrency: 4 },
    })
    expect(rows.find(row => row.id === 'memory-outcome-reconciler')).toMatchObject({
      name: '@relay-harness/rlh-memory-outcome-reconciler',
      config: { agentId: 'relay-harness', concurrency: 4 },
    })
    expect(rows.find(row => row.id === 'ui-memory-center')).toMatchObject({
      name: '@relay-harness/rlh-client-ui-memory-center',
    })
    expect(manifest.dependencies).toHaveProperty('@relay-harness/rlh-host-memory-center')
    expect(manifest.dependencies).toHaveProperty('@relay-harness/rlh-client-ui-memory-center')
    expect(manifest.dependencies).toHaveProperty('@relay-harness/rlh-memory-outcome-reconciler')
  })
})
