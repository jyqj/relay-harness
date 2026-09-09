import { spawn, spawnSync } from 'node:child_process'

/** Run an isolated smoke, settling only after its process and output pipes close. */
export function runSmokeProcess(executable, args, {
  cwd, env, timeoutMs, label, terminationGraceMs = 1_000,
  stdout = process.stdout, stderr = process.stderr,
}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      const probe = spawnSync('ps', ['-p', String(process.pid), '-o', 'pid='], { encoding: 'utf8', timeout: 1_000 })
      if (probe.status !== 0) {
        reject(new Error(`${label} requires ps to observe its process groups`, { cause: probe.error }))
        return
      }
    }
    const child = spawn(executable, args, {
      cwd, env, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    const groups = new Set(child.pid === undefined ? [] : [child.pid])
    const owners = new Map()
    let failure
    let closed = false
    let outcome
    let forceTimer
    let drainTimer
    let groupPoll
    let settled = false

    // The Harness runtime may create its own process group. Remember those
    // descendants while the Electron owner is alive, before they can be reparented.
    function collectGroups() {
      if (process.platform === 'win32' || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 1_000 })
      if (result.status !== 0) return
      const rows = result.stdout.trim().split('\n').map(line => {
        const fields = line.trim().split(/\s+/)
        return [Number(fields[0]), Number(fields[1]), Number(fields[2]), fields.slice(3).join(' ')]
      })
      const descendants = new Set([child.pid])
      let changed = true
      while (changed) {
        changed = false
        for (const [pid, parent] of rows) {
          if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true }
        }
      }
      for (const [pid, , group, started] of rows) {
        if (descendants.has(pid) && descendants.has(group)) groups.add(group)
        if (pid === group && groups.has(group) && !owners.has(group)) owners.set(group, started)
      }
      for (const group of groups) if (!groupExists(group)) groups.delete(group)
    }

    function groupExists(group) {
      try { process.kill(-group, 0) } catch (error) {
        if (error.code === 'ESRCH') return false
        if (error.code === 'EPERM') return true
        throw error
      }
      const result = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1_000 })
      if (result.status !== 0) return true
      return result.stdout.split('\n').some(line => {
        const [id, state] = line.trim().split(/\s+/)
        return Number(id) === group && state && !state.startsWith('Z')
      })
    }

    function signalGroups(signal) {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore', windowsHide: true, timeout: 10_000,
        })
        if (result.error) failure = new AggregateError([failure, result.error].filter(Boolean), `${label} termination failed`)
        return
      }
      collectGroups()
      for (const group of groups) {
        const started = owners.get(group)
        if (started !== undefined) {
          const current = spawnSync('ps', ['-p', String(group), '-o', 'lstart='], { encoding: 'utf8', timeout: 1_000 })
          if (current.status === 0 && current.stdout.trim().replace(/\s+/g, ' ') !== started) {
            groups.delete(group)
            continue
          }
        }
        try { process.kill(-group, signal) } catch (error) {
          if (error.code !== 'ESRCH') failure = new AggregateError([failure, error].filter(Boolean), `${label} termination failed`)
        }
      }
    }

    function finish() {
      if (settled || !closed) return
      if (process.platform !== 'win32' && [...groups].some(groupExists)) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      clearTimeout(drainTimer)
      clearInterval(tracking)
      clearInterval(groupPoll)
      if (failure) reject(failure)
      else resolve(outcome)
    }

    function terminate(reason) {
      if (failure !== undefined) return
      failure = reason
      signalGroups('SIGTERM')
      forceTimer = setTimeout(() => { signalGroups('SIGKILL'); finish() }, terminationGraceMs)
      groupPoll = setInterval(finish, 100)
      // If the OS refuses termination, preserve evidence rather than falsely
      // reporting cleanup or deleting a profile still in use.
      drainTimer = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(timer); clearTimeout(forceTimer); clearInterval(tracking); clearInterval(groupPoll)
        child.stdout.destroy(); child.stderr.destroy(); child.unref()
        const error = new Error(`${label} could not establish process quiescence`, { cause: failure })
        error.quiescent = false
        reject(error)
      }, terminationGraceMs + 10_000)
    }

    const tracking = setInterval(collectGroups, 1_000)
    const timer = setTimeout(() => terminate(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs)
    child.stdout.on('data', chunk => stdout.write(chunk))
    child.stderr.on('data', chunk => stderr.write(chunk))
    child.once('error', error => {
      failure = error
      if (child.pid === undefined) { closed = true; finish() }
    })
    child.once('close', (code, signal) => {
      closed = true
      outcome = { code, signal }
      if (!failure && process.platform !== 'win32' && [...groups].some(groupExists)) {
        terminate(new Error(`${label} exited with live descendant process groups`))
      }
      finish()
    })
  })
}
