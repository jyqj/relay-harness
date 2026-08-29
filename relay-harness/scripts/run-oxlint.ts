import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const oxlintCli = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url))
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024
const FIX_FLAGS = new Set(['--fix', '--fix-dangerously', '--fix-suggestions'])

function isFixInvocation(args: readonly string[]): boolean {
  return args.some(arg => FIX_FLAGS.has(arg))
}

function hasOutputFormat(args: readonly string[]): boolean {
  return args.some(arg =>
    arg === '-f'
    || arg.startsWith('-f=')
    || arg === '--format'
    || arg.startsWith('--format='))
}

/** Complete Oxlint child-process arguments and environment. */
export interface OxlintInvocation {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/** Observable completion facts from one Oxlint child process. */
export interface OxlintProcessResult {
  readonly error?: Error
  readonly signal: NodeJS.Signals | null
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Whether a child result is buffered for a decision or owns the parent streams directly. */
export type OxlintProcessMode = 'capture' | 'inherit'

/** Synchronous child-process seam used to verify bounded retry orchestration deterministically. */
export type OxlintProcessRunner = (
  invocation: OxlintInvocation,
  mode: OxlintProcessMode,
) => OxlintProcessResult

/** Captured output channels used only when the first fix pass succeeds. */
export interface OxlintOutput {
  /** Write bytes captured from Oxlint stdout. */
  readonly stdout: (text: string) => void
  /** Write bytes captured from Oxlint stderr. */
  readonly stderr: (text: string) => void
}

function completionOf(result: OxlintProcessResult): Pick<OxlintProcessResult, 'signal' | 'status'> {
  return { signal: result.signal, status: result.status }
}

/**
 * Apply the repository worker bound to both Oxlint backends.
 * @param args - Oxlint CLI arguments requested by the caller.
 * @param env - Environment inherited by the Oxlint process.
 * @returns the complete CLI arguments and child environment.
 */
export function resolveOxlintInvocation(args: readonly string[], env: NodeJS.ProcessEnv): OxlintInvocation {
  const resolvedArgs = [...args]
  if (env.CI === 'true' && !hasOutputFormat(args)) resolvedArgs.push('--format=unix')
  const raw = env.RLH_OXLINT_THREADS
  if (raw === undefined || raw === '') return { args: resolvedArgs, env: { ...env } }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`run-oxlint: RLH_OXLINT_THREADS must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  if (args.some(arg => arg === '--threads' || arg.startsWith('--threads='))) {
    throw new Error('run-oxlint: use RLH_OXLINT_THREADS instead of passing --threads directly.')
  }
  return {
    args: [...resolvedArgs, `--threads=${raw}`],
    env: { ...env, GOMAXPROCS: raw },
  }
}

function completeFrom(result: { readonly signal: NodeJS.Signals | null; readonly status: number | null }): void {
  if (result.signal !== null) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.status ?? 1
}

function spawnOxlint(invocation: OxlintInvocation, mode: OxlintProcessMode): OxlintProcessResult {
  if (mode === 'capture') {
    const result = spawnSync(process.execPath, [oxlintCli, ...invocation.args], {
      encoding: 'utf8',
      env: invocation.env,
      maxBuffer: MAX_CAPTURED_OUTPUT_BYTES,
    })
    return {
      ...result.error === undefined ? {} : { error: result.error },
      signal: result.signal,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
  const result = spawnSync(process.execPath, [oxlintCli, ...invocation.args], {
    env: invocation.env,
    stdio: 'inherit',
  })
  return {
    ...result.error === undefined ? {} : { error: result.error },
    signal: result.signal,
    status: result.status,
    stdout: '',
    stderr: '',
  }
}

/**
 * Run validation once or a fix invocation with one bounded retry.
 * @param invocation - completed Oxlint arguments and environment.
 * @param runner - synchronous process runner; production uses the real Oxlint executable.
 * @param output - parent channels for a successful captured first fix pass.
 * @returns the final child completion used for signal and exit-status propagation.
 */
export function executeOxlint(
  invocation: OxlintInvocation,
  runner: OxlintProcessRunner = spawnOxlint,
  output: OxlintOutput = {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  },
): Pick<OxlintProcessResult, 'signal' | 'status'> {
  if (!isFixInvocation(invocation.args)) {
    const result = runner(invocation, 'inherit')
    if (result.error !== undefined) throw result.error
    return completionOf(result)
  }

  const first = runner(invocation, 'capture')
  if (first.error !== undefined) throw first.error
  if (first.signal !== null) return completionOf(first)
  if (first.status === 0) {
    output.stdout(first.stdout)
    output.stderr(first.stderr)
    return completionOf(first)
  }

  // Overlapping JS-plugin fixes can expose one more fixable diagnostic after the first pass.
  const second = runner(invocation, 'inherit')
  if (second.error !== undefined) throw second.error
  return completionOf(second)
}

function main(): void {
  const invocation = resolveOxlintInvocation(process.argv.slice(2), process.env)
  completeFrom(executeOxlint(invocation))
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) main()
