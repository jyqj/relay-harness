#!/usr/bin/env node
import { runSmokeProcess } from './smoke-process.mjs'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSmokeResult, createSmokeDirs, initGitWorkspace, reservePort, writeSmokeConfig,
} from './smoke-workspace.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const timeoutMs = Number(process.env.RLH_SMOKE_TIMEOUT_MS) || 300_000

function electronExecutable() {
  if (process.env.ELECTRON_PATH && existsSync(process.env.ELECTRON_PATH)) {
    return process.env.ELECTRON_PATH
  }
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(root, 'node_modules', 'electron', 'dist', 'electron'),
  ]
  const found = candidates.find((item) => existsSync(item))
  if (!found) {
    throw new Error('Source smoke needs a local Electron binary (npm ci, then node node_modules/electron/install.js).')
  }
  return found
}

function run(executable, args, env) {
  return runSmokeProcess(executable, args, { cwd: root, env, timeoutMs, label: 'Source smoke' })
}

const dirs = createSmokeDirs('rlh-source-smoke-')
let keepArtifacts = process.env.RLH_SMOKE_KEEP === '1'

try {
  const executable = electronExecutable()
  initGitWorkspace(dirs.workspace)
  const port = await reservePort()
  writeSmokeConfig(dirs.userData, dirs.workspace, port)

  console.log(`Source smoke: ${executable}`)
  const outcome = await run(executable, ['.', `--user-data-dir=${dirs.userData}`, '--no-first-run'], {
    ...process.env,
    RLH_HOME: dirs.rlhHome,
    RLH_SMOKE: '1',
  })

  if (!existsSync(dirs.resultPath)) {
    throw new Error(`Smoke result was not written (exit=${outcome.code}, signal=${outcome.signal || 'none'}).`)
  }
  const result = JSON.parse(readFileSync(dirs.resultPath, 'utf8'))
  assertSmokeResult(outcome, result)
  console.log(`Source smoke passed on port ${port}; UI, titlebar hits, and PTY probes are healthy.`)
} catch (error) {
  if (error.quiescent === false) keepArtifacts = true
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  if (keepArtifacts) {
    console.log(`Smoke artifacts kept at ${dirs.smokeRoot}`)
  } else {
    try {
      rmSync(dirs.smokeRoot, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      console.warn(`Could not remove smoke artifacts at ${dirs.smokeRoot}: ${error.message}`)
    }
  }
}
