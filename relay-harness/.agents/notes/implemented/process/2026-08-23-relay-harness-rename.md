# Agent Note: Relay Harness rename

Status: implemented

English | [中文](2026-08-23-relay-harness-rename.zh.md)

## Problem

The harness shipped under a name it does not own. Every npm package sat in the `@deepseek-ai` scope, the binary was `dsh`, environment variables carried the `DSH_` prefix, and `BRAND_GUIDELINES.md` asserted DeepSeek trademark ownership. The repository belongs to the Relay product, and DeepSeek is a model vendor it calls over HTTP, not its publisher. Publishing under another company's scope is a claim the project cannot make.

The token also collides with itself. `dsh` names four different things across the tree — the npm scope suffix, the CLI binary, the `package.json` protocol namespace, and the CSS custom-property family `--dsw-*` — and a partial rename leaves readers unable to tell which occurrences are brand and which are vendor API surface.

## Decision

The product is **Relay Harness**, abbreviated **rlh**. The rename covers every brand-owned surface at once, executed by [`scripts/rebrand-dsh-to-rlh.ts`](../../../../scripts/rebrand-dsh-to-rlh.ts):

| Surface | Before | After |
|---|---|---|
| npm scope and package names | `@deepseek-ai/dsh-<pkg>` | `@relay-harness/rlh-<pkg>` |
| CLI binary and `pnpm` script | `dsh` | `rlh` |
| Environment variables | `DSH_*` | `RLH_*` |
| `package.json` protocol namespace | `"dsh": { client, profile, bundle }` | `"rlh": { … }` |
| Browser boot global | `window.__DSH_BOOT__` | `window.__RLH_BOOT__` |
| CSS custom properties | `--dsw-*`, `--ds-*` | `--rlw-*`, `--rl-*` |
| Repository URL | `github.com/deepseek-ai/deepseek-harness` | `github.com/jyqj/relay-harness` |
| Desktop app id | `ai.deepseek.harness.gui` | `com.relayharness.desktop` |
| Mobile bundle id | `ai.deepseek.harness.mobile` | `com.relayharness.mobile` |

Directory and file names follow the same tokens: `.agents/skills/dsh-*` became `rlh-*`, `dshbot` became `rlhbot`, and `install-dsh-plugin*` became `install-rlh-plugin*`.

The pre-release stance in [AGENTS.md](../../../../AGENTS.md) governs the blast radius: there are no external consumers, so no compatibility aliases exist for the old scope, binary name, or environment variables. Reading a `DSH_*` variable is not a supported fallback; it is simply unset.

One variable is read from outside the repository and so is worth naming. [`patches/node-pty@1.2.0-beta.15.patch`](../../../../patches/node-pty@1.2.0-beta.15.patch) makes the pty spawn helper path overridable for an embedder that ships the helper somewhere other than beside the addon, and nothing in this tree sets it. That override is now `RLH_NODE_PTY_SPAWN_HELPER`, and an embedder still exporting the old name gets the unpatched sibling lookup rather than an error. The rename is also why the `node-pty` `patch_hash` moves in `pnpm-lock.yaml`: the patch text changed, not the package version.

### What the rename does not touch

Three categories keep their original spelling, and the codemod protects each with an explicit pattern so a re-run cannot erode them.

**Model-vendor references.** `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `api.deepseek.com`, DeepSeek model identifiers, and the `llm-deepseek` adapter name identify a third-party API this project calls. They are no more renameable than an HTTP header name.

**Third-party plugin ecosystem coordinates.** The desktop marketplace fetches `https://awesome-dsh-plugin.com/plugins.json` and installs community plugins such as `dsh-composer-expand` and `github:0xsline/dsh-spotlight`. Those hosts, npm names, and repository paths belong to other authors, so rewriting them points the installer at packages that do not exist. [`apps/desktop/src/main/marketplace-registry-snapshot.json`](../../../../apps/desktop/src/main/marketplace-registry-snapshot.json) mirrors that registry verbatim; the codemod rewrites only the leading CLI token of each `install` command, because that token alone names this repository's binary.

**Sealed archive artifacts.** Frozen Agent Note triplets under `.agents/notes/archived/<kind>/` and their manifest keep the vocabulary they had when sealed. [`archived/AGENTS.md`](../../archived/AGENTS.md) carries the token mapping readers need. That file is instruction prose rather than a sealed artifact, so it follows the rename.

### Telemetry

The rename removed a hardcoded reporting endpoint rather than rebranding it. Session telemetry mounts disabled: [`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) defaults `mode` to `DISABLED` and resolves the collector URL from `RLH_TELEMETRY_OTLP_URL` with no built-in default. A deployment that wants telemetry names its own collector; an unconfigured install reports nowhere.

## Alternatives considered

**Keep `@relay-harness` and rename only the product prose.** Cheapest, and wrong at the only layer that matters: the npm scope is a publishing identity. Retaining it while calling the product Relay Harness misstates who ships the packages.

**Introduce `rlh` as an alias and deprecate `dsh` over time.** Standard practice with external consumers, but there are none. Aliases would double the surface every gate, doc, and fixture must cover, in exchange for compatibility nobody is asking for. The pre-release stance in AGENTS.md exists precisely to decline this trade.

**Leave `--dsw-*` CSS tokens alone to minimize churn.** Tempting, since token names are internal and the renderer does not care. Rejected because the token family is the most user-visible `ds` residue in shipped stylesheets, and a half-renamed vocabulary is harder to reason about than either endpoint. The tokens moved with everything else.

**Hand-edit instead of writing a codemod.** Rejected at roughly 5,700 files. A script also makes the exclusions reviewable: the protected-span list is the specification of what is vendor surface rather than brand, which no sequence of manual edits could state.

## Consequences

The old names are gone with no migration path, which is the intended cost of renaming before the first tagged release. Anyone with an existing `$DSH_HOME` directory, a `dsh` on `PATH`, or a `DSH_*` variable in a shell profile starts over; on-disk session data is unaffected because `SESSION_FORMAT_VERSION` did not change.

Generated artifacts had to be regenerated rather than rewritten, because their anchors derive from package names: `docs/config-catalog.md` and `docs/tool-catalog.md` now slug to `relay-harnessrlh-*`, and every inbound link, including the Chinese translations the generators do not produce, was repointed.

The codemod stays in the tree after the migration. It is idempotent — no rule output matches any rule input — so a stray reintroduced `dsh` is caught by re-running it, and the protected-span list documents the vendor/brand boundary in executable form.

Third-party marketplace coordinates remain the fragile part. They read as brand tokens and only fail at install or fetch time, far from the edit that broke them. The protected patterns enumerate the affected plugin names, so a registry snapshot that adds a new `dsh-`prefixed community plugin needs that name added before the codemod runs again. The same applies to a vendored plugin's `upstream` coordinate in [`apps/desktop/vendor/plugins.json`](../../../../apps/desktop/vendor/plugins.json): `npm:dshmarket` names the package the drop came from, so the codemod protects the whole `"upstream": "npm:…"` value rather than the one name.

Protecting those names by the bare token costs precision in the other direction, and one occurrence had to be fixed by hand: `dsh-web-ui` is a community plugin the catalog lists by bare name, and it was also the name a rejected alternative in [GUI layering and RPC protocol](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) gave one of this repository's own packages. The protection covered both, so the note kept a `dsh-` name after the rename; it now reads `rlh-web-ui`. A token that names a community plugin and a package here at once cannot be resolved by pattern — check prose that quotes a protected name by hand.
