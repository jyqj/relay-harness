# Agent Note: Stage the dependency backlog behind the rename instead of inside it

Status: proposed

English | [中文](2026-08-23-staged-dependency-upgrades.zh.md)

## Problem

The `dsh` → `rlh` rename regenerated `pnpm-lock.yaml` wholesale: every one of the 281 workspace packages changed name, so the lockfile diff is almost entirely rename churn. That is exactly the wrong moment to also move dependency versions. A reviewer auditing the lockfile for "did the rename touch a resolution it should not have" cannot do that if upgrades are interleaved, and a regression bisected to the rename commit could equally be a bumped transitive dependency.

Meanwhile the backlog is real and uneven. `pnpm outdated -r` reports 63 distinct packages behind latest, and they are not one population:

| Level | Count | Character |
|---|---|---|
| major | 21 | Ecosystem migrations. React 18 → 19, TypeScript 6 → 7, Vite 5/6 → 8, `js-yaml` 4 → 5, `zustand` 4 → 5, `@agentclientprotocol/sdk` 0.25 → 1.4. |
| minor | 26 | Mostly additive, but includes wide surfaces: `oxlint` (new lint rules land as new failures), `@anthropic-ai/sdk` 0.93 → 0.120, `e2b` 2.29 → 2.45, `katex` 0.16 → 0.18. |
| patch | 16 | Bug fixes to tools and leaf libraries: `vitest`, `tsdown`, `esbuild`, `koffi`, `ws`, `execa`, `lefthook`. |

Treating those as one task produces either a stalled upgrade or an unreviewable one.

## Proposal

Land no dependency upgrades in the rename PR, and work the backlog afterwards in three separately-revertable waves, each with its own PR.

**Wave 1 — patch.** All 16 patch bumps in one `pnpm update -r` pass. These carry no API change by contract, so the whole wave shares a single verification: `pnpm run doc-sync`, `pnpm run lint`, `pnpm run typecheck`, and the full test suite. If the wave is green it lands as one commit; if one package breaks, drop that package and re-run rather than splitting the wave.

Two entries deserve a note even at patch level. `koffi` 3.1.1 → 3.1.6 is a native FFI addon behind the sandbox, filesystem, and subprocess packages on Windows and macOS — CI on Linux will not exercise most of it. `esbuild` 0.28.1 → 0.28.2 is pre-1.0, where the ecosystem convention puts breaking changes in the patch position; read its changelog rather than trusting the version shape.

**Wave 2 — minor, in three groups.** Split by blast radius so a failure names its own cause:

- Tooling that gates CI (`oxlint`, `knip`, `playwright`, `publint`, `pnpm`, `lefthook`). New linter versions ship new rules; expect findings and budget for fixing or explicitly disabling them, since a silent `--fix` pass would bury real ones.
- Model and sandbox SDKs (`@anthropic-ai/sdk`, `@openai/codex`, `@earendil-works/pi-ai`, `@modelcontextprotocol/sdk`, `e2b`). These are the packages whose real behavior only appears in with-key tests; run those, do not rely on the keyless suite.
- Rendering and leaf libraries (`shiki`, `@shikijs/langs`, `katex`, `mermaid`, `lightningcss`, `fast-check`, `smol-toml`, `tsx`, `use-sync-external-store`). Snapshot churn is the expected outcome here; review the rendered diffs rather than blanket-updating snapshots.

**Wave 3 — major, one PR per package or per coupled set.** These are migrations, not upgrades, and several are coupled:

- `react` + `react-dom` + `@types/react` + `@types/react-dom` + `@vitejs/plugin-react` move together, and `zustand` 4 → 5 and `use-sync-external-store` belong in the same change because zustand 5 drops the default-export and the shim that React 19 makes unnecessary.
- `typescript` 6 → 7 and `typescript-language-server` 5 → 6 move together, and this one reaches further than its diff suggests: `packages/typert` generates type models from the checker, and its snapshots encode checker-internal type ids.
- `vite` 5/6 → 8 is two hops with a plugin-API break in each, and the repo is on two majors at once today; unify to one before crossing to 8.
- `js-yaml` 4 → 5, `chokidar` 4 → 5, `immer` 10 → 11, `supports-color` 9 → 11, `eventsource-parser` 3 → 4, `@babel/code-frame` 7 → 8 are independent and each small enough to stand alone.
- `@agentclientprotocol/sdk` 0.25 → 1.4 crosses a pre-1.0 boundary on a wire protocol. It needs the ACP example's snapshot suite re-recorded and read, not refreshed.

Order the waves 1 → 2 → 3, and inside wave 3 do TypeScript before React: the React migration is easier to read when the checker is not also moving.

## Alternatives considered

**Bundle patch upgrades into the rename PR.** Tempting because patch bumps are individually safe and it saves a PR. Rejected because the cost is not the risk of any single bump, it is the loss of the lockfile as an auditable artifact. The rename already rewrites every workspace entry in `pnpm-lock.yaml`; the only remaining signal that the rename did not perturb a resolution is that no third-party version moved. Adding 16 deliberate version moves erases exactly that signal for no schedule gain.

**Upgrade everything and fix the fallout.** A single `pnpm update -r --latest` and then chase failures until green. Rejected because React 19, TypeScript 7, and Vite 8 each change enough that their failures interleave: a component that breaks under React 19 and a type that breaks under TypeScript 7 present as one undifferentiated wall of errors, and neither can be reverted independently once they share a commit.

**Pin the current versions and stop tracking.** Declare the tree's versions the supported set. Rejected because several of these are security-relevant surfaces — `ws`, `koffi`, the sandbox and model SDKs — where staying still is its own risk, and because the gap only ever widens: React 18 → 19 is harder today than it was, and harder still next quarter.

**Adopt Renovate or Dependabot instead of a staged plan.** Automation is the right long-term answer for waves 1 and 2 and this note does not argue against it. It is not a substitute for wave 3: a bot can open the React 19 PR but cannot make the migration decisions inside it, and turning a bot on against a 63-package backlog produces a queue nobody reviews. Sequence it after wave 2, when the remaining backlog is small enough that a bot's output is reviewable.

## Acceptance criteria

- The rename PR merges with `pnpm-lock.yaml` showing workspace renames and no third-party version changes. The one non-rename entry is `node-pty`'s `patch_hash`, which moves because the patch text carries a renamed environment variable; the resolved version is unchanged.
- Wave 1 lands as one commit with `doc-sync`, `lint`, `typecheck`, and the full test suite green, and the `koffi` and `esbuild` changelogs read rather than assumed.
- Wave 2 lands as three commits, each independently revertable, with new lint findings resolved rather than suppressed wholesale.
- Wave 3 lands one migration per PR, each carrying its own Agent Note where it changes an observable contract, with the ACP snapshot suite re-recorded and reviewed for the SDK crossing.

## Risks

Staging is slower than a single sweep, and the backlog grows while the waves land — by the time wave 3 starts, wave 1's packages will have moved again. That is accepted: re-running wave 1 is cheap precisely because it is mechanical.

The plan assumes CI coverage that Linux CI does not fully provide. `koffi` drives Windows ACL sandboxing and macOS filesystem paths, and the with-key model tests are skipped without secrets. A wave can be green in CI and still regress on a platform or path no gate exercises; waves 1 and 2 should be validated on a real desktop build before wave 3 stacks on top of them.

Deferring the majors means the repo runs React 18 and TypeScript 6 for the whole staging period, so new client code written in the interim is written against the older API and may need revisiting during the React 19 migration.
