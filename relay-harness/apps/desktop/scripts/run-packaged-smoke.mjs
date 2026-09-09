#!/usr/bin/env node
import { runSmokeProcess } from './smoke-process.mjs'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSmokeResult, createSmokeDirs, initGitWorkspace, reservePort, writeSmokeConfig,
} from './smoke-workspace.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const distDir = path.join(root, 'dist')
const timeoutMs = Number(process.env.RLH_SMOKE_TIMEOUT_MS) || 300_000

function packagedExecutable() {
  if (process.env.RLH_SMOKE_EXE) {
    return path.resolve(process.env.RLH_SMOKE_EXE)
  }
  if (process.platform === 'win32') {
    return path.join(distDir, 'win-unpacked', `${packageJson.productName}.exe`)
  }
  if (process.platform === 'darwin') {
    const appExecutable = path.join(`${packageJson.productName}.app`, 'Contents', 'MacOS', packageJson.productName)
    for (const output of ['mac-arm64', 'mac-universal', 'mac']) {
      const candidate = path.join(distDir, output, appExecutable)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`Packaged smoke is not configured for ${process.platform}.`)
}

function run(executable, args, env) {
  return runSmokeProcess(executable, args, { cwd: root, env, timeoutMs, label: 'Packaged smoke' })
}

const dirs = createSmokeDirs('rlh-packaged-smoke-')
let keepArtifacts = process.env.RLH_SMOKE_KEEP === '1'

try {
  const executable = packagedExecutable()
  if (!existsSync(executable)) {
    throw new Error(`Packaged executable not found: ${executable}`)
  }

  initGitWorkspace(dirs.workspace)
  const port = await reservePort()
  writeSmokeConfig(dirs.userData, dirs.workspace, port)

  console.log(`Packaged smoke: ${executable}`)
  const outcome = await run(executable, [`--user-data-dir=${dirs.userData}`, '--no-first-run'], {
    ...process.env,
    RLH_HOME: dirs.rlhHome,
    RLH_SMOKE: '1',
  })

  if (!existsSync(dirs.resultPath)) {
    throw new Error(`Smoke result was not written (exit=${outcome.code}, signal=${outcome.signal || 'none'}).`)
  }
  const result = JSON.parse(readFileSync(dirs.resultPath, 'utf8'))
  assertSmokeResult(outcome, result)
  console.log(`Packaged smoke passed on port ${port}; UI, titlebar hits, and PTY probes are healthy.`)
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
