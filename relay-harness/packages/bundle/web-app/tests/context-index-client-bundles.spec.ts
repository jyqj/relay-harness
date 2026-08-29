import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packages = [
  ['ui-code-index-center', '@relay-harness/rlh-client-ui-code-index-center'],
  ['ui-context-inspector', '@relay-harness/rlh-client-ui-context-inspector'],
] as const

describe('Context and Code Index browser artifact contracts', () => {
  for (const [directory, packageName] of packages) {
    it(`${packageName} declares the standard clientBundle build`, () => {
      const root = resolve('packages/client', directory)
      const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
        exports?: Record<string, { default?: string }>
        files?: string[]
      }
      const config = readFileSync(resolve(root, 'tsdown.config.ts'), 'utf8')
      expect(config).toContain("import { clientBundle } from '../tsdown.client.ts'")
      expect(config).toContain(`'${packageName}'`)
      expect(manifest.scripts).toMatchObject({ bundle: 'tsdown', watch: 'tsdown --watch' })
      expect(manifest.exports?.['./client']?.default).toBe('./lib/client.js')
      expect(manifest.files).toContain('lib/client.js')
    })
  }
})
