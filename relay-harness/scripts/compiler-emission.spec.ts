/** A failed compiler face must not spill generated files into source directories. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('refuses emission when a compiler face imports a source outside its rootDir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rlh-no-emit-on-error-'))
  try {
    const app = join(root, 'app')
    await mkdir(app)
    const entry = join(app, 'index.ts')
    const outside = join(root, 'outside.ts')
    await writeFile(entry, "export { value } from '../outside'\n")
    await writeFile(outside, 'export const value = 1\n')
    const config = ts.readConfigFile(resolve('tsconfig.base.json'), file => ts.sys.readFile(file))
    expect(config.error).toBeUndefined()
    const source = config.config as { compilerOptions: Record<string, unknown> }
    const converted = ts.convertCompilerOptionsFromJson(source.compilerOptions, resolve('.'))
    expect(converted.errors).toEqual([])
    const program = ts.createProgram([entry], {
      noEmitOnError: converted.options.noEmitOnError === true,
      rootDir: app,
      outDir: join(app, 'out'),
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      declaration: true,
    })
    expect(ts.getPreEmitDiagnostics(program).some(diagnostic => diagnostic.code === 6059)).toBe(true)
    expect(program.emit().emitSkipped).toBe(true)
    expect((await readdir(root)).sort()).toEqual(['app', 'outside.ts'])
    expect(await readdir(app)).toEqual(['index.ts'])
    expect(await readFile(outside, 'utf8')).toBe('export const value = 1\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
