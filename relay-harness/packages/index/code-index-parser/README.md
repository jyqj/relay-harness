# @relay-harness/rlh-code-index-parser

English | [中文](README.zh.md)

Tree-sitter parsing layer for the Relay Harness code-index capability: it turns one file's text into the extraction records the derived index stores — symbols, imports, call edges, and string literals — over vendored web-tree-sitter grammars plus a grammar-free regex tier, with deterministic id generation, import-path resolution, and symbol-aware chunking alongside.

This package is part of the code-index capability:

| Package | Role |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition: abstract service, vocabulary types, repository-size tiers |
| `@relay-harness/rlh-code-index-parser` (this) | Parsing layer: grammar loading, per-file extraction records, chunking |
| `@relay-harness/rlh-code-index-sqlite` | Storage repository: schema, epoch-bumped writes, retrieval port adapter |
| `@relay-harness/rlh-code-index-search` | Retrieval domain engine: preselection, lanes, fusion, rerank |
| `@relay-harness/rlh-code-index-local` | Service Provider: scan/diff/chunk pipeline wired behind `ctx.codeIndex` |
| `@relay-harness/rlh-tool-code-index` | Consumer: model-facing search/status/refresh tools |

## Parsing

`parseFile(relPath, text, options)` classifies the path against the full reference extension table, and returns `null` only when the file exceeds `maxFileBytes` or its extension has no parser — the caller falls back to generic line chunking in exactly those cases. Extraction failures never throw: they land in `parseErrors` formatted `"<file>: <message>"` (counted by `parseErrorCount`) with whatever records were extracted beforehand.

Walker coverage spans every vendored language at its reference tier: the JS/TS family (JavaScript, TypeScript, TSX, JSX; `jsx` parses with the JavaScript grammar) and Python at `semantic` (confidence 0.85), Go, Java, and C/C++ at `tree-sitter` (0.7) with dedicated walkers for symbols and imports. The JS/TS walker additionally extracts function/generator/class/method/variable symbols with TypeScript parameter and return types, ES `import`/`export`/`export ... from` plus CommonJS `require()` in both binding forms, call edges (member, direct, optional-chain, constructor) merged from the AST pass and a regex fallback by `(line, startCol)`, and string literals in the 3–160 byte window. Framework roles cover React hooks/components, middleware, NestJS controllers/services, and `@Get`-style decorators marking route handlers. Deferred export application binds `export { local as exported }` and `export default local` to their symbols, and marks two-step forwarding of an imported binding as a re-export.

The eight languages without a vendored grammar — C#, PHP, Ruby, Swift, Kotlin, Dart, Scala, and Lua — parse through the spec-driven extractor at `heuristic` (confidence 0.5): per-language declaration patterns produce symbols (namespace/package context feeds qualified names; indented or qualified functions count as methods; spans end at an estimate, not a parsed body), one import pattern per language fills import records, and every parse also emits same-file call edges — each `name(` site whose bare callee matches an in-file function/method, guarded by a control-flow keyword blocklist, declaration-line and self-loop skips, and an innermost-enclosing-caller rule.

Vue and Svelte single-file components parse at `heuristic` with the confidence the reference SFC parser pins (0.78): every `<script>` block lifts onto the JS/TS walker over a synthetic text padded so extracted records keep their original file lines, `lang="ts"` selects the TypeScript grammar, and the file gains one synthetic `component` symbol spanning it — PascalCase name from the path stem, default-exported, uid over the component identity. The template contributes one unresolved component-usage ref per PascalCase tag (the component's own name skipped) and template-event call edges (`@evt="h"` / `v-on:evt="h"` for Vue, `on:evt={h}` for Svelte) dispatched as `event_emitter`, all carrying the `sfc_template` strategy tag.

Import specifiers resolve against the workspace root (`resolveImport`): Python dotted modules (`a.b` → `a/b.py` or `a/b/__init__.py`), relative JS specifiers through the `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` extension order then `/index` files, exact extension matches, and a `null` for bare modules or specifiers that escape above the root — an escaping `..` never collapses into a bogus intra-project edge.

Chunks follow the reference semantics: one chunk per symbol span, non-blank gap text between spans, fixed windows (80 lines by default, breadcrumb kept as the bare symbol name) for oversized symbols, and a pure line-window fallback when a file has no symbols. Ids are SHA-256-derived and deterministic: `uid:` symbol identity over `(file, qname, kind, normalized signature)` survives line drift, while `sym:`/`call:`/`lit:`/`chunk:` positional ids pin file/line/column.

## Grammars

`resources/grammars/` vendors the nine grammar wasm files (ten languages — `jsx` shares JavaScript) with their provenance and exact byte sizes recorded in `resources/grammars/VERSION`. The runtime (`Parser.init()`) and each grammar load once per process and are memoized; a failed load is isolated per language and never poisons the cache.

## Model Experience

Indirectly, through the `search_code_index` results whose chunk metadata — symbols, breadcrumbs, and excerpts — this layer extracts.

#### KV Cache effect

No direct request-prefix changes; extraction records only shape what the index stores, and retrieval answers key their cacheability on the index epoch pair, not on parse internals.

## Known Limitations and Deferred Work

- **The spec-driven tier trades precision for coverage** — the C#, PHP, Ruby, Swift, Kotlin, Dart, and Lua extractor has no AST: symbol spans end at an indentation/`end`-keyword estimate (200-line scan window, 30-line fallback), signatures and parameter types are never populated, a declaration-shaped call line (`return Helper(x)` in C#) yields a phantom method symbol, and call edges resolve only intra-file by bare name. C# `Environment.GetEnvironmentVariable` data-flow edges stay unported (no data-flow records in this phase's vocabulary).
- **Spec-driven import specifiers rarely resolve** — C#/Kotlin/Scala dotted modules, Swift frameworks, Dart `package:` URIs, and bare Ruby/Lua module names are unresolvable by the shared resolver by design; only relative specifiers carrying a real file extension (e.g. Ruby `require '../util.rb'`) resolve to project files.
- **String-literal extraction is JS/TS/Python/Rust only** — the Go, Java, C/C++, and spec-driven walkers emit symbols, imports, and call edges but no literal rows; their literal extraction lands with the classification phase that consumes it.
- **No parse-timeout API** — web-tree-sitter exposes no interrupt mechanism like the reference's `set_timeout_micros`; the mitigation is per-file isolation (a failure becomes one `parseErrors` entry, never a stuck index pass) plus error-tolerant traversal of malformed trees.
- **Single-threaded WASM performance** — parses run on the calling thread with a per-file parser instance; a worker/subprocess pool remains a deferred option if large workspaces need it.
- **Literals are indexed verbatim** — classification (route/url/env-key/… categories) arrives with the literal-indexing phase.
- **The SFC layer is a regex heuristic, not a template compiler** — `<script>` blocks match by regex and re-parse through the JS/TS grammars, so template-only syntax contributes no script records; the synthetic component symbol spans the whole file regardless of where the script sits, and script blocks sharing one source line clamp to distinct synthetic lines. Multi-block files keep every block's records at their original lines by padding each block relative to the synthetic text, where the reference re-pads from the file start and drifts later blocks — a documented deviation.
- **SFC confidence deviates from the heuristic default** — vue and svelte report the reference SFC parser's hardcoded 0.78 while every other heuristic-tier language sits at 0.5; the pin lives in the tier table, not in the tier default.
- **SFC dispatch sites are not ported** — the reference's `VueChildComponent`/`VueEventHandler` dispatch-site records and the `synthesized_by`/`synthesis_key`/`registered_*` provenance columns are out of scope for this package's vocabulary; SFC provenance rides the `sfc_template` `resolutionStrategy` tag, and both template records are born `unresolved` for the resolution phase.
- **Identifier refs beyond SFC templates are empty** — `symbolRefs` carries only the SFC template layer's component-usage refs; general identifier extraction ships with the resolution phase, and call-position references ride `callEdges`.
- **Ids are not cross-compatible with the reference implementation** — SHA-256 here versus blake3 there; the two stores never mix, so no interop is required.
- **Stores built earlier in Phase 2 carry stale id values** — per-occurrence ids now fold line/column into the hash as little-endian u32 words, so ids derived by earlier Phase 2 builds no longer match; rebuild such a store once with `refresh({ forceRebuild: true })`.
- **Grammar wasms are read-only vendored assets** — never regenerated in place; `resources/grammars/VERSION` records each upstream release URL and byte size. The `tree-sitter-wasms@0.1.13` npm package ships a legacy `dylink` section format that web-tree-sitter 0.26 cannot load, so the vendored artifacts come from the official grammar repositories' release builds.
