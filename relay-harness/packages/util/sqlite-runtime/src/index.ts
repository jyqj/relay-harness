/** One lazy synchronous load boundary for the process-owned Node SQLite builtin. */
let sqlite: typeof import('node:sqlite') | undefined

/**
 * Load the Node builtin without its exact SQLite stability notice. All other
 * warnings delegate unchanged, and the original emitter is restored before
 * returning or throwing; no asynchronous work crosses this boundary.
 * @returns the cached builtin module; callers own every database they open.
 */
export function loadNodeSqlite(): typeof import('node:sqlite') {
  if (sqlite !== undefined) return sqlite
  const emitWarning = Reflect.get(process, 'emitWarning')
  process.emitWarning = (warning: string | Error, ...args: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning
    const first = args[0]
    const type = warning instanceof Error ? warning.name
      : typeof first === 'string' ? first
        : typeof first === 'object' && first !== null && 'type' in first ? first.type : undefined
    if (message === 'SQLite is an experimental feature and might change at any time' && type === 'ExperimentalWarning') return
    Reflect.apply(emitWarning, process, [warning, ...args])
  }
  try {
    sqlite = process.getBuiltinModule('node:sqlite')
    return sqlite
  } finally {
    process.emitWarning = emitWarning
  }
}
