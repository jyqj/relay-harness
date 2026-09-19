/** Check action-owned package paths before dependencies can be installed. */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Require each pnpm setup step to select the nested manifest in its own with block.
 * Repository workflows use block-style action inputs; inline inputs are rejected
 * rather than partially interpreted. Shell working-directory defaults are irrelevant.
 * @param {string} text Workflow YAML using block-style action steps.
 * @param {string} name Workflow name for diagnostics.
 * @returns {number} Number of checked pnpm setup steps.
 */
export function verifyPnpmSetupPaths(text, name) {
  const lines = text.split('\n')
  let checked = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s*(?:-\s+)?uses:\s*['"]?pnpm\/action-setup@/.test(line)) continue
    checked += 1
    const column = line.indexOf('uses:')
    let inWith = false
    let found = false
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]
      if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) continue
      const indent = candidate.length - candidate.trimStart().length
      if (indent < column) break
      if (indent === column) inWith = /^with:\s*(?:#.*)?$/.test(candidate.trim())
      if (inWith && indent === column + 2
        && /^package_json_file:\s*(?:relay-harness\/package\.json|"relay-harness\/package\.json"|'relay-harness\/package\.json')\s*(?:#.*)?$/.test(candidate.trim())) {
        found = true
      }
    }
    if (!found) throw new Error(`${name}:${index + 1}: pnpm setup requires with.package_json_file: relay-harness/package.json`)
  }
  return checked
}

/**
 * Check all root workflows without loading third-party YAML or package-manager code.
 * @param {string} directory Absolute path to the workflow directory.
 * @returns {Promise<number>} Number of validated pnpm setup steps.
 */
export async function verifyWorkflowPnpm(directory) {
  let checked = 0
  for (const name of await readdir(directory)) {
    if (!/\.ya?ml$/.test(name)) continue
    checked += verifyPnpmSetupPaths(await readFile(resolve(directory, name), 'utf8'), name)
  }
  return checked
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows')
  const checked = await verifyWorkflowPnpm(directory)
  console.log(`workflow-pnpm: PASS (${checked} setup steps)`)
}
