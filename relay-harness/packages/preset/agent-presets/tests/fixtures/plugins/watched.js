import { watch, appendFileSync } from 'node:fs'

export const name = 'watched-preset-fixture'
export function apply(ctx, config) {
  ctx.effect(() => {
    const watcher = watch(config.directory, () => {})
    return () => {
      watcher.close()
      appendFileSync(config.closed, `${config.generation}\n`)
    }
  })
}
