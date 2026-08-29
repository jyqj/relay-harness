import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chunkWithSymbols } from '../src/chunker.ts'
import { edgeId, refId, symbolUid } from '../src/id.ts'
import { parseFile } from '../src/index.ts'
import {
  componentNameFromPath,
  extractSfc,
  SFC_CONFIDENCE,
  SFC_TEMPLATE_CONFIDENCE,
} from '../src/languages/sfc.ts'

const root = mkdtempSync(join(tmpdir(), 'rlh-parser-sfc-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const OPTIONS = { projectRoot: root, maxFileBytes: 512_000 }

describe('component name from path', () => {
  it.each([
    ['user-profile-card.vue', 'UserProfileCard'],
    ['snake_case_name.svelte', 'SnakeCaseName'],
    ['spaced name.vue', 'SpacedName'],
    ['App.vue', 'App'],
    ['app.vue', 'App'],
    // A dot is not a separator, so it survives into the name (reference
    // `component_name_from_path` behavior).
    ['chart.widget.vue', 'Chart.widget'],
    ['nested/dir/user-card.vue', 'UserCard'],
    ['noext', 'Noext'],
    ['---.vue', 'Component'],
  ])('maps %s to %s', (filePath, expected) => {
    expect(componentNameFromPath(filePath)).toBe(expected)
  })
})

describe('sfc script extraction', () => {
  it('preserves original line numbers across multiple script blocks', async () => {
    const content = [
      '<template>',
      '  <Plot />',
      '</template>',
      '',
      '<script>',
      'export function helper() {',
      '  return 1',
      '}',
      '</script>',
      '',
      '<style>',
      '.x { color: red }',
      '</style>',
      '',
      '<script setup lang="ts">',
      'const count: number = 2',
      '',
      'function render(who: string): string {',
      '  return who',
      '}',
      '</script>',
    ].join('\n')
    const outcome = await extractSfc('vue', 'src/Chart.vue', content)

    // Script-block records sit at their original file lines, not the
    // synthetic text's.
    expect(outcome.symbols.find(sym => sym.name === 'helper')).toMatchObject({
      kind: 'function',
      startLine: 6,
      endLine: 8,
      exportName: 'helper',
    })
    expect(outcome.symbols.find(sym => sym.name === 'count')).toMatchObject({
      kind: 'variable',
      startLine: 16,
    })
    // `lang="ts"` on the second block selects the TypeScript grammar for the
    // combined script — the annotations below only yield type info from a TS
    // parse.
    expect(outcome.symbols.find(sym => sym.name === 'render')).toMatchObject({
      kind: 'function',
      startLine: 18,
      paramTypes: 'string',
      returnType: 'string',
    })
  })

  it('upgrades to the TypeScript grammar from any block and any quote style', async () => {
    const content = [
      "<script lang='ts'>",
      'function sized(size: number): number {',
      '  return size',
      '}',
      '</script>',
      '<script>',
      'function plain() {}',
      '</script>',
    ].join('\n')
    const outcome = await extractSfc('vue', 'src/Mixed.vue', content)
    expect(outcome.symbols.find(sym => sym.name === 'sized')).toMatchObject({
      paramTypes: 'number',
      returnType: 'number',
    })
    expect(outcome.symbols.find(sym => sym.name === 'plain')).toBeDefined()
  })

  it('clamps the line padding when blocks share the source line', async () => {
    const content = '<script>function a() {}</script><script>function b() {}</script>'
    const outcome = await extractSfc('vue', 'src/Inline.vue', content)
    expect(outcome.symbols.find(sym => sym.name === 'a')).toMatchObject({ startLine: 1 })
    // Line 1 is already consumed by the first block's separator, so the
    // second block clamps to the next synthetic line.
    expect(outcome.symbols.find(sym => sym.name === 'b')).toMatchObject({ startLine: 2 })
  })

  it('extracts script imports and literals through the JS/TS walker', async () => {
    const content = [
      '<script>',
      'import { fmt } from "./fmt"',
      'const route = "/usage-count"',
      '</script>',
      '<template><p>{{ route }}</p></template>',
    ].join('\n')
    const outcome = await extractSfc('vue', 'src/Labeled.vue', content)
    expect(outcome.imports).toHaveLength(1)
    expect(outcome.imports[0]).toMatchObject({ importString: './fmt' })
    expect(outcome.literals.some(lit => lit.literal === '/usage-count')).toBe(true)
  })

  it('skips the JS/TS walker for template-only files', async () => {
    const outcome = await extractSfc('svelte', 'src/Empty.svelte', '<div>static</div>')
    expect(outcome.symbols).toHaveLength(1)
    expect(outcome.imports).toEqual([])
    expect(outcome.callEdges).toEqual([])
    expect(outcome.literals).toEqual([])
    // An empty file still spans one line (the reference's `max(1)`).
    const empty = await extractSfc('vue', 'src/None.vue', '')
    expect(empty.symbols[0]).toMatchObject({ name: 'None', endLine: 1 })
  })
})

describe('sfc component symbol', () => {
  const filePath = 'src/Panel.vue'
  const content = [
    '<template>',
    '  <FooBar @click="onClick" />',
    '  <Form v-on:submit="onSubmit" />',
    '</template>',
    '<script>',
    'function onClick() {',
    '  track("click")',
    '}',
    'function onSubmit() {}',
    '</script>',
  ].join('\n')

  it('prepends the synthetic component with every field populated', async () => {
    const outcome = await parseFile(filePath, content, OPTIONS)
    expect(outcome!.language).toBe('vue')
    expect(outcome!.parserTier).toBe('heuristic')
    expect(outcome!.parserConfidence).toBe(SFC_CONFIDENCE)
    expect(outcome!.summary).toBe(`${filePath} (vue, 10 lines, 3 symbols)`)
    expect(outcome!.symbols[0]).toEqual({
      symbolId: edgeId('sym', filePath, 1, 0),
      filePath,
      name: 'Panel',
      kind: 'component',
      container: null,
      startLine: 1,
      endLine: 10,
      startCol: 0,
      endCol: 0,
      signature: 'vue component',
      parserTier: 'heuristic',
      parserConfidence: SFC_CONFIDENCE,
      qname: 'Panel',
      parentSymbolId: null,
      exportName: 'Panel',
      isDefaultExport: true,
      symbolUid: symbolUid(filePath, 'Panel', 'component', 'component'),
      frameworkRole: 'component',
      receiverType: null,
      paramTypes: null,
      returnType: null,
      paramCount: null,
    })
    // Merge-order contract: walker symbols follow the component.
    expect(outcome!.symbols.slice(1).map(sym => sym.name)).toEqual(['onClick', 'onSubmit'])
  })

  it('chunks a small component as one whole-file span plus script spans', async () => {
    const outcome = await parseFile(filePath, content, OPTIONS)
    const chunks = chunkWithSymbols({
      filePath,
      content,
      language: 'vue',
      parserTier: 'heuristic',
      parserConfidence: SFC_CONFIDENCE,
      symbols: outcome!.symbols,
    })
    // The component span covers the file; script symbols repeat inside it,
    // and the closing line past the last script span falls to a gap chunk
    // (the chunker's unconditional `covered` advance).
    expect(chunks[0]).toMatchObject({
      startLine: 1,
      endLine: 10,
      breadcrumb: 'Panel',
      symbolName: 'Panel',
      symbolKind: 'component',
    })
    expect(chunks.slice(1).map(chunk => chunk.symbolName)).toEqual(['onClick', 'onSubmit', null])
  })

  it('windows an oversized component while keeping its breadcrumb', async () => {
    const template = Array.from({ length: 95 }, (_, i) => `  <Row n="${i}" />`)
    const content = ['<template>', ...template, '</template>'].join('\n')
    const outcome = await parseFile('src/BigTable.svelte', content, OPTIONS)
    const chunks = chunkWithSymbols({
      filePath: 'src/BigTable.svelte',
      content,
      language: 'svelte',
      parserTier: 'heuristic',
      parserConfidence: SFC_CONFIDENCE,
      symbols: outcome!.symbols,
    })
    // 97 lines over the 80-line budget: two windows under the component's
    // name, and no duplicate whole-file chunk.
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 80, breadcrumb: 'BigTable' })
    expect(chunks[1]).toMatchObject({ startLine: 81, endLine: 97, breadcrumb: 'BigTable' })
    expect(chunks.filter(chunk => chunk.symbolName === 'BigTable')).toHaveLength(2)
  })
})

describe('sfc template refs', () => {
  const filePath = 'src/Panel.vue'
  const content = [
    '<template>',
    '  <FooBar @click="onClick" />',
    '  <Form v-on:submit="onSubmit" />',
    '  <lower-tag />',
    '</template>',
    '<script>',
    'function onClick() {}',
    'function onSubmit() {}',
    '</script>',
  ].join('\n')

  it('emits one unresolved component-usage ref per PascalCase tag', async () => {
    const outcome = await parseFile(filePath, content, OPTIONS)
    expect(outcome!.symbolRefs).toHaveLength(2)
    const [fooBar, form] = outcome!.symbolRefs
    expect(fooBar).toEqual({
      refId: refId(filePath, 'FooBar', 2, 3),
      filePath,
      symbolName: 'FooBar',
      container: 'Panel',
      refKind: 'component_usage',
      line: 2,
      column: 3,
      targetSymbolId: null,
      targetFilePath: null,
      targetSymbolUid: null,
      refName: 'FooBar',
      scopeId: null,
      resolutionKind: 'unresolved',
      resolutionConfidence: 0,
      resolutionStrategy: 'sfc_template',
      refEndLine: 2,
      refEndCol: 3 + 'FooBar'.length,
      parserTier: 'heuristic',
      parserConfidence: SFC_TEMPLATE_CONFIDENCE,
    })
    expect(form).toMatchObject({ symbolName: 'Form', line: 3, column: 3 })
  })

  it('never emits a self-reference for the component tag', async () => {
    const outcome = await extractSfc('vue', 'src/Widget.vue', '<template>\n  <Widget />\n</template>')
    expect(outcome.symbolRefs).toEqual([])
  })
})

describe('sfc template events', () => {
  const filePath = 'src/Panel.vue'
  const content = [
    '<template>',
    '  <FooBar @click="onClick" />',
    '  <Form v-on:submit="onSubmit" />',
    '</template>',
    '<script>',
    'function onClick() {',
    '  track("click")',
    '}',
    'function onSubmit() {}',
    '</script>',
  ].join('\n')

  it('emits event_emitter template edges after the script edges', async () => {
    const outcome = await parseFile(filePath, content, OPTIONS)
    const template = outcome!.callEdges.slice(-2)
    expect(template.map(edge => edge.calleeSymbol)).toEqual(['onClick', 'onSubmit'])
    expect(template[0]).toEqual({
      edgeId: edgeId('call', filePath, 2, 18),
      filePath,
      callerSymbol: 'Panel',
      calleeSymbol: 'onClick',
      line: 2,
      startCol: 18,
      endLine: 2,
      endCol: 18 + 'onClick'.length,
      callerSymbolUid: symbolUid(filePath, 'Panel', 'component', 'component'),
      dispatchKind: 'event_emitter',
      callKind: 'template_event',
      receiverExpr: null,
      argCount: null,
      isOptionalChain: false,
      isAwaited: false,
      isConstructor: false,
      parserTier: 'heuristic',
      parserConfidence: SFC_TEMPLATE_CONFIDENCE,
      resolutionKind: 'unresolved',
      resolutionConfidence: 0,
      resolutionStrategy: 'sfc_template',
    })
    // Script-derived edges keep their own vocabulary and precede the
    // template's.
    expect(outcome!.callEdges[0]).toMatchObject({
      calleeSymbol: 'track',
      dispatchKind: 'direct',
      callKind: 'direct',
    })
  })

  it('emits svelte on:x={h} edges', async () => {
    const content = [
      '<script>',
      'function handleClick() {}',
      '</script>',
      '',
      '<main>',
      '  <button on:click={handleClick}>go</button>',
      '</main>',
    ].join('\n')
    const outcome = await parseFile('src/user-card.svelte', content, OPTIONS)
    expect(outcome!.callEdges.filter(edge => edge.callKind === 'template_event')).toEqual([
      expect.objectContaining({
        calleeSymbol: 'handleClick',
        line: 6,
        startCol: 20,
        endCol: 20 + 'handleClick'.length,
        callerSymbol: 'UserCard',
        callerSymbolUid: symbolUid('src/user-card.svelte', 'UserCard', 'component', 'component'),
        dispatchKind: 'event_emitter',
        resolutionStrategy: 'sfc_template',
      }),
    ])
  })

  it('matches handlers only in their own language syntax', async () => {
    const vueOutcome = await extractSfc('vue', 'src/A.vue', '<template>\n  <X on:click={h} />\n</template>')
    expect(vueOutcome.callEdges).toEqual([])
    const svelteOutcome = await extractSfc('svelte', 'src/B.svelte', '<main>\n  <X @click="h" />\n</main>')
    expect(svelteOutcome.callEdges).toEqual([])
  })
})

describe('sfc through parseFile', () => {
  it('resolves script imports against the project root', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'fmt.ts'), 'export function fmt(v: string) {\n  return v\n}\n')
    const content = [
      '<script lang="ts">',
      'import { fmt } from "./fmt"',
      'const out = fmt("ready")',
      '</script>',
      '<template>{{ out }}</template>',
    ].join('\n')
    const outcome = await parseFile('src/Card.vue', content, OPTIONS)
    expect(outcome).not.toBeNull()
    expect(outcome!.imports[0]).toMatchObject({ importString: './fmt', resolvedPath: 'src/fmt.ts' })
    expect(outcome!.isTestFile).toBe(false)
    expect(outcome!.parseErrorCount).toBe(0)
    // Lowercase template markup yields no component-usage refs.
    expect(outcome!.symbolRefs).toEqual([])
  })
})
