# Agent Note: Files/Browser logic port

Status: implemented

English | [中文](2026-08-19-files-browser-logic-port.zh.md)

## Problem

The desktop Files and Browser occupants already owned search, save, and a loopback guest, but they did not carry the rest of the work loops a local reference desktop ships: public https guests, tree drag into the composer, jump-to-line, comments into the composer, open-in-editor, PiP, device toolbar, pick, recording, and CDP automation on the existing guest. Importing that tree at runtime would couple this product to another brand's Effect/Atom/Schema stack, Pierre chrome, and a second Chromium.

## Decision

This desktop ports those Files/Browser loops from the local reference tree `C:\Ai\t3code` and rebrands every live identifier to `rlhd`. Effect/Atom/Schema peel to Promises and `webContents`. Playwright Chromium, `playwright-core`, and `__t3PlaywrightInjected` are not shipped; automation is CDP on the existing guest. Chrome stays official rlh `ui-primitives` plus `--rlw-alias-*` (no Pierre, lucide, shadcn, or Tailwind).

The guest BrowserView is `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. Its preload keeps `ipcRenderer` private and exposes only a frozen `rlhdPreviewGuest` interface through `contextBridge`: annotation submit/cancel and human-input reporting, each pinned to its named preview channel. The harness main window and PiP window also keep `contextIsolation: true`. Guest documents may be any `http(s)`; `file:` documents are cancelled. Address bar `normalizePreviewUrl` treats a bare loopback host as `http` and a bare public host as `https`. The harness main window loopback wall is unchanged.

rlhd extras stay: dirty-tab Keep/Discard/Save, `error.changed`, occupancy hide (`overlayOpen || pipOpen`), and the token-prefixed workspace file server. Preview IPC that reaches the guest is harness-authorized only. Recording is host-renderer `MediaRecorder`; artifacts land under `userData/preview-recordings/`.

The first-frame startup barrier observes a completed draw so the encoder never starts from an unpainted canvas. Startup completion is fenced by recording-instance identity, not preview id alone: the id can be reused after a startup timeout. The recording owns both the encoder and the canvas capture stream. Stopping the encoder finalizes the artifact but does not release the source tracks, so recording cleanup explicitly stops those tracks even when construction, encoding, Host stop, or artifact saving fails.

## Alternatives considered

**Import Effect as-is.** Rejected: this desktop's main process is Promises and `webContents`, not Effect; keeping the foreign runtime would own a second async model for one occupant.

**Fake More items.** Rejected: a menu that names PiP, pick, or recording without the matching IPC would lie.

**Pack a second Chromium.** Rejected: Playwright's browser download would bloat and break electron-builder; CDP on the existing guest is the wiring.

**Copy Pierre into the slot tree.** Rejected: design language requires `ui-primitives` and `--rlw-alias-*`; a second icon/component kit is a second skin.

**Expose `ipcRenderer` to the guest document.** Rejected: a public preview page must not choose arbitrary Electron IPC channels; the isolated preload maps the three outbound operations to fixed channels while the main process validates annotation payloads on that guest's own `webContents`.

**Open the harness main window to public http(s).** Rejected: the main window still loads the harness UI and the user API key; only the guest document may be public `http(s)`.

## Consequences

Guest, main, and PiP all isolate their page world from preload privileges. The guest's page-facing bridge cannot invoke, subscribe to, or name arbitrary IPC channels. Recording frames arrive over IPC into the host renderer; there is no second browser. Artifacts under `userData/preview-recordings/` are desktop-local files. Harness-only preview IPC stays authorized on `window.shell`; the boot window never receives guest control channels.

## Testing

`src/main/workspace-fs.test.js` pins the 1 MiB caps and traversal. `src/main/preview.test.js` pins public https guests, pick, PiP isolation, late capture suppression after recording replacement, and automation method wiring against fakes. `src/main/preview-session.test.js` pins isolated guest webPreferences and leftover UA-token strip. `preview-guest-protocol.test.js` pins the exact frozen bridge keys and their three outbound messages; `preview-guest-preload.test.js` rejects a raw `ipcRenderer` global. `src/preload/shell-api.test.js` pins authorized preview IPC. `ui-files` pins uncapped search, mention drag, revealLine, and Add to chat. `ui-preview` pins More occupancy hide including PiP, device-toolbar `setBounds`, pick markdown, and host MediaRecorder with a fake recorder. Live Electron MediaRecorder and live CDP on a real guest are not proven.

## Related

[Right-panel and terminal work loops](2026-08-16-surfaces-terminal-work-loops.md) owns the Files/Browser/Terminal loops this port fills. [Conversation links into Files and Browser](2026-08-19-conversation-surface-links.md) owns html/svg dual-open and the token workspace file server.
