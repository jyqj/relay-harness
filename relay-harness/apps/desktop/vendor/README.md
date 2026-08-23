Desktop-only bundled plugins and the upstream import pin live here. Harness source is the monorepo root and is not duplicated under this directory.

The vendored `rlhmarket`/`rlhbot` trees intentionally track their `node_modules/` and `lib/` in git: the desktop installer must bundle them offline via electron-builder `extraResources`, and `src/main/rlhmarket-preset.test.js` asserts both the tracked state and the packaging path.
