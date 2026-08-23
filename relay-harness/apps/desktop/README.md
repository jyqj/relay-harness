# Relay-Harness-Desktop

English | [中文](README.zh.md)

Desktop client based on the official Relay Harness Web UI.

Themes, wallpapers, and other personalization options. Download, install, and run — RLH is bundled.

[Download](https://github.com/jyqj/relay-harness/releases/latest) · [Relay Harness](https://github.com/jyqj/relay-harness)

## Install

Grab a build from [Releases](https://github.com/jyqj/relay-harness/releases/latest). No local Node required.

| | |
| --- | --- |
| Windows x64 | `Relay-Harness-Desktop-Setup-*.exe` |
| macOS Apple Silicon | `Relay-Harness-Desktop-*-mac-arm64.dmg` |
| Intel Mac, Linux | [Run from source](#run-from-source) |

The macOS build is unsigned: right-click → Open, or run `xattr -cr /Applications/Relay-Harness-Desktop.app`.

## Features

- **Official UI** — Chat, tool calls, and approvals are `rlh web`. There is no custom chat page.
- **Git** — Switch branches, commit, push, and open a pull request from the title bar.
- **Files and terminal** — `Ctrl+\` opens the right column (Files / Diff / Browser / Agents); `` Ctrl+` `` opens the bottom terminal. A selection can join chat.
- **Models** — Thinking intensity for third-party models, vision fallback; the latest user message can be edited and resent.
- **Appearance** — Light / dark themes. Pick a wallpaper or browse the gallery with categories, search, favorites, and window-aware cropping.
- **Extensions** — Manage MCP, Skills, and plugins in Settings. The marketplace is the bundled [rlh-market](https://github.com/dsh-market/dsh-market) plugin (`rlhmarket`).
- **Desktop** — Minimize to tray, auto-update, Harness crash recovery, and a startup path that can skip a broken user plugin tree.

`Ctrl+,` opens Settings.

<table>
  <tr>
    <td align="center" width="50%"><img src="assets/screenshot-surfaces.jpg" alt="Chat and Files column" /></td>
    <td align="center" width="50%"><img src="assets/screenshot-wallpaper.jpg" alt="Wallpaper" /></td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src="assets/screenshot-themes.jpg" alt="Theme library" /></td>
    <td align="center" width="50%"><img src="assets/screenshot-appearance.jpg" alt="Appearance settings" /></td>
  </tr>
</table>

## Run from source

Windows 10+ or macOS 14+ (Apple Silicon), Node 22.19+ / 24+, pnpm 11.

```powershell
pnpm install
pnpm run build
pnpm run dev:desktop
```

The desktop app launches this monorepo's Harness source and Web build directly. Quit the installed app before a source launch; they share a single-instance lock.

## Development

Harness UI code lives under the repository root's `packages/client/`; the Electron shell lives under `apps/desktop/src/`. Follow the [design language](docs/design-language.en.md) and [motion](docs/motion.en.md). After changing client sources, run `pnpm run build:lib:client` at the repository root and restart the desktop app.

`vendor/harness-upstream.json` records only the import baseline and npx fallback version. The titlebar, Git, surfaces column, terminal drawer, and their Harness packages are part of this monorepo.

```powershell
pnpm run test:desktop      # desktop unit tests
pnpm run dist:desktop      # Windows installer
pnpm run dist:desktop:mac  # macOS installer (must run on macOS)
```

## License

[MIT](LICENSE)
