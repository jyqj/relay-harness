# Agent Note: Adopt web-tree-sitter as the code-index parsing dependency

Status: proposed

English | [中文](2026-08-27-web-tree-sitter-dependency.zh.md)

## Problem

The code-index capability needs AST-grade extraction (symbols, call edges, imports) that regex scanning cannot deliver, and the first parser package (`@relay-harness/rlh-code-index-parser`) must choose its parsing substrate. Hand-rolling a parser is a non-starter; the real decisions are which tree-sitter binding to take, which prebuilt grammar artifacts to vendor, and which reference-implementation behaviors to deliberately deviate from. This note records those decisions for the `web-tree-sitter` dependency and its grammar supply chain.

## Proposal

### Depend on `web-tree-sitter` (WASM tree-sitter runtime)

Judged against the [dependency bar](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md):

- **Net deletion.** A native tree-sitter binding per grammar would add nine native build/test matrices and a compiled-artifact supply chain we do not have; a hand-written recursive-descent JS/TS parser would add thousands of lines we would own outright. One WASM runtime dependency plus nine read-only data files replaces all of that, and the record vocabulary it populates is the contract the index already defines.
- **Health.** `web-tree-sitter` is the upstream tree-sitter project's own browser/Node binding, widely deployed and actively maintained; `^0.26.13` resolves to a current release. Transitive footprint is zero (no runtime dependencies).
- **Fit at the boundary.** `Parser.init()` + `Language.load()` + a per-file `parse()` maps one-to-one onto the `parseFile` seam; the incremental-parsing features we do not need stay unused, and no residual wrapper semantics are hand-rolled around it.
- **No hard allowlist needed.** The [dependency policy](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md) explicitly rejected a standing allowlist in favor of this per-PR evidence; this note is that evidence for this package.

Supply-chain considerations: `web-tree-sitter` ships **no install scripts** (no postinstall/preinstall) — the published package is a JS bundle plus its wasm blob, so `pnpm install` executes nothing on its behalf. The grammar wasms are **vendored read-only data**, not npm packages, with provenance and byte sizes pinned in `resources/grammars/VERSION` and enforced by `tests/grammar-provenance.spec.ts` (wasm magic, per-file < 5 MB, total < 25 MB budgets).

### Grammar artifacts come from official grammar releases, not `tree-sitter-wasms`

The natural npm candidate, `tree-sitter-wasms@0.1.13`, builds grammars with a 2022-era toolchain whose side modules carry the legacy `dylink` custom section. `web-tree-sitter` 0.26's Emscripten runtime requires the `dylink.0` section and fails at `Language.load` with "need dylink section". Every published `tree-sitter-wasms` version shares this format, so no npm-published grammar bundle currently works with the pinned runtime. The vendored artifacts therefore come from the official `tree-sitter/*` grammar repositories' release builds (which carry `dylink.0`), with each file's release URL and byte size recorded in `resources/grammars/VERSION`. This trades npm provenance for artifact correctness; if `tree-sitter-wasms` ever publishes `dylink.0` builds, the source can switch back in one vendoring pass.

### Deviate from the reference implementation's blake3 ids — use SHA-256

The Rust reference derives ids with blake3. This package uses Node's SHA-256 (`node:crypto`) with documented input constructions locked by `tests/id.spec.ts`. Rationale: blake3 would add a native or WASM dependency for a property (determinism) SHA-256 already provides, and the two implementations' stores never mix — cross-library id compatibility is explicitly a non-goal. Cost: ids differ byte-for-byte from the reference's; any future import of a reference-built store needs an explicit migration, which the store's monotonic `SCHEMA_VERSION` mechanism already anticipates.

### Replace the missing parse-timeout API with per-file isolation

The reference guards pathological files with `parser.set_timeout_micros`. `web-tree-sitter` exposes no interrupt mechanism for a synchronous WASM parse. The substitute is containment rather than interruption: every parse is one `parseFile` call whose failure becomes a formatted `parseErrors` entry, the WASM parser/tree are deleted in `finally`, and malformed input degrades to error-tolerant traversal instead of aborting the index pass. A worker/subprocess pool with a hard kill remains the documented escalation if real workspaces produce files that need it; it is deferred until evidence demands it.

## Alternatives considered

- **Native `tree-sitter` bindings per grammar.** Rejected for this phase: nine compiled artifacts and platform matrices for a capability whose consumers are pure-JS; revisit only if WASM parse throughput proves insufficient.
- **WASI tree-sitter runtimes (`tree-sitter` 0.25's WASI build).** Rejected: younger API surface, and the grammar-artifact compatibility question would remain.
- **Pin an older `web-tree-sitter` that still loads legacy `dylink` grammars.** Rejected: that means pinning an unmaintained runtime to keep a low-quality artifact source; flipping the artifact source is the smaller, more correct move.

## Risks

- **Parse throughput on WASM.** A synchronous WASM parse is slower than a native binding; if real workspaces outgrow it, the escape hatch is the documented worker/subprocess escalation, not a runtime swap.
- **Artifact source is a release feed, not npm.** Grammar wasms come from `tree-sitter/*` GitHub releases; provenance and byte budgets are pinned and tested, but a release-channel outage blocks grammar refreshes until the pins move.
- **Ids never interoperate with the reference's stores.** SHA-256 ids differ byte-for-byte from blake3 ids; importing a reference-built store would need an explicit migration.

## Acceptance criteria

- `@relay-harness/rlh-code-index-parser` builds, passes its suites at per-file 100% coverage, and its coexistence probe runs `node:sqlite` and a web-tree-sitter parse in one process.
- `resources/grammars/` contains exactly the nine vendored wasms plus `VERSION`, each loadable by the pinned runtime, within the provenance budgets.
- Id determinism and input constructions stay locked by dedicated tests; no blake3 dependency appears.
- Known limitations above stay visible in the package README until the deferred phases land.

## Links

- Dependency policy: [prefer maintained dependencies over hand-rolling](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)
- Supply-chain ownership: [supply-chain and vendor drift](../process/2026-06-11-supply-chain-and-vendor-drift.md)
- Vendoring decision (why grammars are vendored data, not vendored packages): [vendor cordis as source](../../implemented/process/2026-06-11-vendor-cordis-as-source.md)
