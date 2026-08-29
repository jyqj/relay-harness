import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@relay-harness/cordis-plugin-include'

describe('Web product-shell composition', () => {
  it('ships the persisted Host owner before the shared Client product shell', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const base = resolve(root, '..', 'base')
    const baseManifest = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
      schema: entryListSchema,
    }) as { insert?: { id: string; name: string }[] }[]
    const rows = parsed.flatMap(item => item.insert ?? [])
    const baseParsed = yaml.load(readFileSync(resolve(base, 'cordis.patch.yml'), 'utf8'), {
      schema: entryListSchema,
    }) as { insert?: { id: string; name: string }[] }[]
    const baseRows = baseParsed.flatMap(item => item.insert ?? [])
    const host = baseRows.find(row => row.id === 'product-mode')
    const client = rows.find(row => row.id === 'ui-product-shell')
    expect(host).toMatchObject({ name: '@relay-harness/rlh-host-product-mode' })
    expect(client).toMatchObject({ name: '@relay-harness/rlh-client-ui-product-shell' })
    expect(baseManifest.dependencies).toHaveProperty('@relay-harness/rlh-host-product-mode')
    expect(manifest.dependencies).toHaveProperty('@relay-harness/rlh-client-ui-product-shell')
  })
})
