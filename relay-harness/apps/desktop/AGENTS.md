# AGENTS.md — Relay-Harness-Desktop

Electron desktop shell around this monorepo's Relay Harness Web UI. Source launches use the repository root directly; packaged builds still assemble an isolated runtime under `resources/vendor/relay-harness`.

## Design language (mandatory)

Any UI, layout, or frontend change must follow the official `rlh web` visual language. Do not invent a second skin for the desktop chrome or new panels. The boot page is the documented instrument-canvas exception in [docs/design-language.md](docs/design-language.md#桌面启动页); do not spread that sheet.

- Product spec: [docs/design-language.md](docs/design-language.md)
- Motion recipes and inventory: [docs/motion.md](docs/motion.md)
- Token / CSS Modules mechanics: [../../docs/web-styling.md](../../docs/web-styling.md)
- Client plugin rules: [../../packages/client/AGENTS.md](../../packages/client/AGENTS.md)

Reuse `ui-primitives` and `--rlw-alias-*` tokens. The boot page consumes official font/motion tokens from [src/shared/rlh-webui-tokens.css](src/shared/rlh-webui-tokens.css) plus the `--boot-*` table in [src/renderer/boot-tokens.css](src/renderer/boot-tokens.css).

Harness-internal work also follows [../../AGENTS.md](../../AGENTS.md).

## Static checks

This app is plain JavaScript, so it sits outside the repository TypeScript solution and outside the root type-aware lint pass. Three gates cover it instead, all runnable from the repository root and all wired into the CI static lanes:

```sh
pnpm run test:desktop       # node --test suites
pnpm run typecheck:desktop  # tsc over the opted-in files
pnpm run lint:desktop       # type-independent oxlint rules
```

`tsconfig.json` sets `checkJs: false`, so type checking is **opted into per file** with a leading `// @ts-check` pragma. A file that carries the pragma must stay clean; a file without it is still read for inference but reports nothing. Widen the coverage by fixing a file's types and adding the pragma in the same change — never by deleting a pragma to make a change compile. `src/main/release-ui-walk.js` and `src/main/composer-official-qa.js` are excluded outright: they are release QA scripts evaluated inside a live Electron page and are not in the packaged build.

## Surfaces and terminal (work loops)

The right column and conversation terminal drawer implement **work loops** (Files search/save, Browser navigation, Diff scopes, selection into chat), not an empty-state card grid. Empty-state cards are not done. Contract: [2026-08-16-surfaces-terminal-work-loops.md](../../.agents/notes/implemented/feature/2026-08-16-surfaces-terminal-work-loops.md). Out of scope (GPU terminal embedding, worktree, turn-diff, review-comment pick) stays in that note; do not fake those capabilities.

Surface tabs keep the close control **to the right of the title**. Do not move it unless the user explicitly asks.
