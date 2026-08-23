# Agent Note: Relay Harness rename

Status: implemented

English | [中文](2026-08-23-relay-harness-rename.zh.md)

## Problem

The harness shipped under a name it does not own. Every npm package sat in the `@relay-harness` scope, the binary was `rlh`, environment variables carried the `RLH_` prefix, and `BRAND_GUIDELINES.md` asserted DeepSeek trademark ownership. The repository belongs to the Relay product, and DeepSeek is a model vendor it calls over HTTP, not its publisher. Publishing under another company's scope is a claim the project cannot make.

The token also collides with itself. `rlh` names four different things across the tree — the npm scope suffix, the CLI binary, the `package.json` protocol namespace, and the CSS custom-property family `--rlw-*` — and a partial rename leaves readers unable to tell which occurrences are brand and which are vendor API surface.

## Decision

The product is **Relay Harness**, abbreviated **rlh**. The rename covers every brand-owned surface at once, executed by [`scripts/rebrand-dsh-to-rlh.ts`](../../../../scripts/rebrand-dsh-to-rlh.ts):

| Surface | Before | After |
|---|---|---|
| npm scope and package names | `@relay-harness/rlh-<pkg>` | `@relay-harness/rlh-<pkg>` |
| CLI binary and `pnpm` script | `rlh` | `rlh` |
| Environment variables | `RLH_*` | `RLH_*` |
| `package.json` protocol namespace | `"rlh": { client, profile, bundle }` | `"rlh": { … }` |
| Browser boot global | `window.__RLH_BOOT__` | `window.__RLH_BOOT__` |
| CSS custom properties | `--rlw-*`, `--rl-*` | `--rlw-*`, `--rl-*` |
| Repository URL | `github.com/jyqj/relay-harness` | `github.com/jyqj/relay-harness` |
| Desktop app id | `com.relayharness.desktop` | `com.relayharness.desktop` |

Directory and file names follow the same tokens: `.agents/skills/rlh-*` became `rlh-*`, `rlhbot` became `rlhbot`, and `install-rlh-plugin*` became `install-rlh-plugin*`.

The pre-release stance in [AGENTS.md](../../../../AGENTS.md) governs the blast radius: there are no external consumers, so no compatibility aliases exist for the old scope, binary name, or environment variables. Reading a `RLH_*` variable is not a supported fallback; it is simply unset.

### What the rename does not touch

Three categories keep their original spelling, and the codemod protects each with an explicit pattern so a re-run cannot erode them.

**Model-vendor references.** `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `api.deepseek.com`, DeepSeek model identifiers, and the `llm-deepseek` adapter name identify a third-party API this project calls. They are no more renameable than an HTTP header name.

**Third-party plugin ecosystem coordinates.** The desktop marketplace fetches `https://awesome-dsh-plugin.com/plugins.json` and installs community plugins such as `dsh-composer-expand` and `github:0xsline/dsh-spotlight`. Those hosts, npm names, and repository paths belong to other authors, so rewriting them points the installer at packages that do not exist. [`apps/desktop/src/main/marketplace-registry-snapshot.json`](../../../../apps/desktop/src/main/marketplace-registry-snapshot.json) mirrors that registry verbatim; the codemod rewrites only the leading CLI token of each `install` command, because that token alone names this repository's binary.

**Sealed archive artifacts.** Frozen Agent Note triplets under `.agents/notes/archived/<kind>/` and their manifest keep the vocabulary they had when sealed. [`archived/AGENTS.md`](../../archived/AGENTS.md) carries the token mapping readers need. That file is instruction prose rather than a sealed artifact, so it follows the rename.

### Telemetry

The rename removed a hardcoded reporting endpoint rather than rebranding it. Session telemetry mounts disabled: [`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) defaults `mode` to `DISABLED` and resolves the collector URL from `RLH_TELEMETRY_OTLP_URL` with no built-in default. A deployment that wants telemetry names its own collector; an unconfigured install reports nowhere.

## Alternatives considered

**Keep `@relay-harness` and rename only the product prose.** Cheapest, and wrong at the only layer that matters: the npm scope is a publishing identity. Retaining it while calling the product Relay Harness misstates who ships the packages.

**Introduce `rlh` as an alias and deprecate `rlh` over time.** Standard practice with external consumers, but there are none. Aliases would double the surface every gate, doc, and fixture must cover, in exchange for compatibility nobody is asking for. The pre-release stance in AGENTS.md exists precisely to decline this trade.

**Leave `--rlw-*` CSS tokens alone to minimize churn.** Tempting, since token names are internal and the renderer does not care. Rejected because the token family is the most user-visible `ds` residue in shipped stylesheets, and a half-renamed vocabulary is harder to reason about than either endpoint. The tokens moved with everything else.

**Hand-edit instead of writing a codemod.** Rejected at roughly 5,700 files. A script also makes the exclusions reviewable: the protected-span list is the specification of what is vendor surface rather than brand, which no sequence of manual edits could state.

## Consequences

The old names are gone with no migration path, which is the intended cost of renaming before the first tagged release. Anyone with an existing `$RLH_HOME` directory, a `rlh` on `PATH`, or a `RLH_*` variable in a shell profile starts over; on-disk session data is unaffected because `SESSION_FORMAT_VERSION` did not change.

Generated artifacts had to be regenerated rather than rewritten, because their anchors derive from package names: `docs/config-catalog.md` and `docs/tool-catalog.md` now slug to `relay-harnessrlh-*`, and every inbound link, including the Chinese translations the generators do not produce, was repointed.

The codemod stays in the tree after the migration. It is idempotent — no rule output matches any rule input — so a stray reintroduced `rlh` is caught by re-running it, and the protected-span list documents the vendor/brand boundary in executable form.

Third-party marketplace coordinates remain the fragile part. They read as brand tokens and only fail at install or fetch time, far from the edit that broke them. The protected patterns enumerate the affected plugin names, so a registry snapshot that adds a new `rlh-`prefixed community plugin needs that name added before the codemod runs again.
