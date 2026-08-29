/**
 * Vue/Svelte single-file component (SFC) extraction: every `<script>` block
 * is lifted onto the JS/TS walker with its original line numbers preserved,
 * and the template contributes component-usage refs plus template-event call
 * edges. Ported from the reference implementation's `sfc.rs` — intentionally
 * lightweight, no template compiler.
 *
 * Porting deltas against the reference (all deliberate):
 * - Dispatch-site records (`VueChildComponent`, `VueEventHandler`) are out of
 *   scope for this package's vocabulary and are not emitted; SFC provenance
 *   rides {@link SFC_PROVENANCE} on `resolutionStrategy` instead of the
 *   reference's `synthesized_by`/`synthesis_key`/`registered_*` columns.
 * - The reference's `sfc_template_component` / `sfc_template_handler`
 *   strategy values collapse into the one {@link SFC_PROVENANCE} tag.
 * - Template positions use the package-wide UTF-8 byte-column convention
 *   (`../columns.ts`); the reference's `line_col_at` counts Unicode chars,
 *   which differs only on non-ASCII template lines.
 * - The reference's summary line names the script-block count; this package's
 *   uniform `formatSummary` owns that surface.
 *
 * @module
 */

import { Buffer } from 'node:buffer'
import { positionOf } from '../columns.ts'
import { edgeId, refId, symbolUid } from '../id.ts'
import { textLineCount } from '../summary.ts'
import type {
  CallEdgeRecord,
  ImportRecord,
  LiteralRecord,
  SymbolRecord,
  SymbolRefRecord,
} from '../types.ts'
import { extractJsts } from './jsts/index.ts'
import type { JstsGrammar } from './jsts/index.ts'

/** Languages the SFC extractor serves. */
export type SfcLanguage = 'vue' | 'svelte'

/**
 * Parser confidence the reference SFC parser hardcodes on its outcome and
 * component symbol. Named deviation from the tier default: `heuristic` sits
 * at 0.5, but the reference `parse_sfc` pins 0.78 — the port preserves the
 * pin (see the package README).
 */
export const SFC_CONFIDENCE = 0.78

/** Parser confidence of the template-layer refs and event edges (reference hardcode). */
export const SFC_TEMPLATE_CONFIDENCE = 0.75

/** `resolutionStrategy` tag marking every record the template layer emits. */
export const SFC_PROVENANCE = 'sfc_template'

/** `<script>` block of a Vue or Svelte SFC (reference `SCRIPT_BLOCK_RE`). */
const SCRIPT_BLOCK_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi
/** `lang="ts"` attribute probe (reference `LANG_TS_RE`). */
const LANG_TS_RE = /\blang\s*=\s*["']ts["']/
/** PascalCase tag opener anywhere in the file (reference `COMPONENT_TAG_RE`). */
const COMPONENT_TAG_RE = /<\s*([A-Z][A-Za-z0-9_.]*)\b/g
/** Vue template handler: `@evt="h"` / `v-on:evt="h"` (reference `VUE_HANDLER_RE`). */
const VUE_HANDLER_RE = /(?:@|v-on:)[A-Za-z0-9_:-]+\s*=\s*["']([A-Za-z_$][A-Za-z0-9_$]*)/g
/** Svelte template handler: `on:evt={h}` (reference `SVELTE_HANDLER_RE`). */
const SVELTE_HANDLER_RE = /on:[A-Za-z0-9_:-]+\s*=\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)/g

/** Raw extraction output for one SFC file. */
export interface SfcExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
  /** Literal rows lifted from the script blocks through the JS/TS walker. */
  readonly literals: LiteralRecord[]
  /** Template component-usage refs. */
  readonly symbolRefs: SymbolRefRecord[]
}

/**
 * Extract one SFC: script blocks go through the JS/TS walker (line numbers
 * preserved by newline padding, `lang="ts"` picking the TypeScript grammar),
 * the synthetic component symbol is prepended, and the template contributes
 * component-usage refs and template-event edges.
 *
 * @param language - `'vue'` or `'svelte'`.
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @returns the extracted records.
 */
export async function extractSfc(
  language: SfcLanguage,
  filePath: string,
  text: string,
): Promise<SfcExtraction> {
  let combinedScript = ''
  let scriptGrammar: JstsGrammar = 'javascript'
  for (const match of text.matchAll(SCRIPT_BLOCK_RE)) {
    const attrs = captureOf(match, 1)
    const body = captureOf(match, 2)
    if (LANG_TS_RE.test(attrs)) scriptGrammar = 'typescript'
    // The body group opens right after `<script` + attrs + `>`; when the tag
    // ends its own line, that leading newline is part of the body and carries
    // the first code line to the next line.
    const bodyStart = match.index + '<script'.length + attrs.length + 1
    // Named deviation from the reference: cc pads every block with the
    // absolute newline count before its body, which keeps the first block's
    // lines exact but pushes later blocks down by the lines earlier blocks
    // already consumed. Padding relative to the synthetic text's current
    // line count pins every block's records to their original file lines —
    // the line-preservation contract the reference targets.
    const padLines = Math.max(
      0,
      positionOf(text, bodyStart).line - 1 - (combinedScript.split('\n').length - 1),
    )
    combinedScript += '\n'.repeat(padLines) + body + '\n'
  }

  const walked = combinedScript.trim() === ''
    ? { symbols: [], imports: [], callEdges: [], literals: [] }
    : await extractJsts(filePath, combinedScript, scriptGrammar)

  const componentName = componentNameFromPath(filePath)
  const componentUid = symbolUid(filePath, componentName, 'component', 'component')
  const component: SymbolRecord = {
    symbolId: edgeId('sym', filePath, 1, 0),
    filePath,
    name: componentName,
    kind: 'component',
    container: null,
    startLine: 1,
    endLine: Math.max(textLineCount(text), 1),
    startCol: 0,
    endCol: 0,
    signature: `${language} component`,
    parserTier: 'heuristic',
    parserConfidence: SFC_CONFIDENCE,
    qname: componentName,
    parentSymbolId: null,
    exportName: componentName,
    isDefaultExport: true,
    symbolUid: componentUid,
    frameworkRole: 'component',
    receiverType: null,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }

  return {
    // Merge order contract: the synthetic component is the first symbol; the
    // walker's own edges precede the template's.
    symbols: [component, ...walked.symbols],
    imports: walked.imports,
    callEdges: [
      ...walked.callEdges,
      ...templateEventEdges(language, text, componentName, componentUid, filePath),
    ],
    literals: walked.literals,
    symbolRefs: templateComponentRefs(text, componentName, filePath),
  }
}

/**
 * The component name for a file path: the basename's stem (last extension
 * stripped) mapped to PascalCase, with `-`/`_`/space forcing the next
 * character uppercase (reference `component_name_from_path`). A stem with no
 * usable characters yields `"Component"`.
 * @param filePath - workspace-relative file path.
 * @returns the PascalCase component name.
 */
export function componentNameFromPath(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  let name = ''
  let upper = true
  for (const ch of stem) {
    if (ch === '-' || ch === '_' || ch === ' ') {
      upper = true
      continue
    }
    name += upper ? ch.toUpperCase() : ch
    upper = false
  }
  return name === '' ? 'Component' : name
}

/** Template component-usage refs: one per PascalCase tag, skipping the self-name. */
function templateComponentRefs(
  text: string,
  componentName: string,
  filePath: string,
): SymbolRefRecord[] {
  const refs: SymbolRefRecord[] = []
  for (const match of text.matchAll(COMPONENT_TAG_RE)) {
    const name = captureOf(match, 1)
    if (name === componentName) continue
    const { line, col } = positionOf(text, match.index + match[0].length - name.length)
    refs.push({
      refId: refId(filePath, name, line, col),
      filePath,
      symbolName: name,
      container: componentName,
      refKind: 'component_usage',
      line,
      column: col,
      targetSymbolId: null,
      targetFilePath: null,
      targetSymbolUid: null,
      refName: name,
      scopeId: null,
      resolutionKind: 'unresolved',
      resolutionConfidence: 0,
      resolutionStrategy: SFC_PROVENANCE,
      refEndLine: line,
      refEndCol: col + Buffer.byteLength(name, 'utf8'),
      parserTier: 'heuristic',
      parserConfidence: SFC_TEMPLATE_CONFIDENCE,
    })
  }
  return refs
}

/** Template event edges: Vue `@evt`/`v-on:evt` or Svelte `on:evt` handler names. */
function templateEventEdges(
  language: SfcLanguage,
  text: string,
  componentName: string,
  componentUid: string,
  filePath: string,
): CallEdgeRecord[] {
  const handlerRe = language === 'vue' ? VUE_HANDLER_RE : SVELTE_HANDLER_RE
  const edges: CallEdgeRecord[] = []
  for (const match of text.matchAll(handlerRe)) {
    const handler = captureOf(match, 1)
    const { line, col } = positionOf(text, match.index + match[0].length - handler.length)
    edges.push({
      edgeId: edgeId('call', filePath, line, col),
      filePath,
      callerSymbol: componentName,
      calleeSymbol: handler,
      line,
      startCol: col,
      endLine: line,
      endCol: col + Buffer.byteLength(handler, 'utf8'),
      callerSymbolUid: componentUid,
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
      resolutionStrategy: SFC_PROVENANCE,
    })
  }
  return edges
}

/**
 * The pattern's capture at `group`. Every SFC pattern's capture groups
 * participate in any successful match, so the guard only satisfies
 * `noUncheckedIndexedAccess`.
 */
function captureOf(match: RegExpExecArray, group: number): string {
  const capture = match[group]
  /* v8 ignore next: the capture groups of every SFC pattern participate in a
     successful match */
  if (capture === undefined) return ''
  return capture
}
