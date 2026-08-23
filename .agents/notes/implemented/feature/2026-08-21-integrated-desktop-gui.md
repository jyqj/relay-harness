# Agent Note: Integrated desktop GUI

Status: implemented

English | [中文](2026-08-21-integrated-desktop-gui.zh.md)

## Problem

The Electron GUI lived in the separate MIT-licensed [Deepseek-Harness-Desktop](https://github.com/ChisaAlter/Deepseek-Harness-Desktop) repository and carried a complete nested Harness fork. Developing the agent and its GUI required editing two checkouts and synchronizing a duplicated `vendor/deepseek-harness` tree.

## Decision

Import the private Electron shell as the `deepseek-harness-desktop` workspace under `apps/desktop/`. Merge the desktop Harness fork against the shared `141eb6fef83422698aef7a981029e843e8161534` baseline into the monorepo's normal `packages/`, `apps/web/`, docs, and composition paths. Source launches resolve the Harness root to the monorepo root; packaged builds still assemble and archive an isolated runtime under `resources/vendor/deepseek-harness`.

The former nested Harness synchronization command is removed. `apps/desktop/vendor/` retains only desktop-bundled plugins and the upstream import pin. Root scripts own desktop development, tests, and distribution:

```sh
pnpm run dev:desktop
pnpm run test:desktop
pnpm run dist:desktop
pnpm run dist:desktop:mac
```

## Alternatives considered

**Keep the desktop repository and nested Harness fork separate.** Rejected because every shared UI, runtime, or protocol change would continue to require two edits and a synchronization step whose output could drift from both sources.

**Copy only packaged Harness artifacts into the Electron application.** Rejected because packaged output is not a maintainable source boundary for the planned desktop fork, and source-mode development would still test a different tree from distribution.

**Rewrite the Electron shell while moving into the monorepo.** Rejected because the shell already owned working desktop, mobile-remote, plugin, and distribution behavior. The integration changes repository ownership without replacing independent application behavior.

## Consequences

Desktop UI packages such as titlebar, Files, Git, Diff, surfaces, preview, terminal, MCP settings, and Skills settings are ordinary Harness workspaces. Their tests and type declarations participate in the same build as the rest of Harness. Desktop-only Electron main/preload/renderer code remains under `apps/desktop/`; mobile remote and bundled `dshmarket`/`dshbot` assets remain owned by that application.

## Testing

`pnpm run test:desktop` covers the Electron shell. Focused Vitest cases cover the merged conversation and scheduler behavior. Host and client TypeScript project builds, client bundle build, Web production build, and `smoke:source` prove the source desktop can boot the assembled Web UI, connect a real temporary Git workspace, open titlebar menus, exercise the right column, and round-trip a real PTY.
