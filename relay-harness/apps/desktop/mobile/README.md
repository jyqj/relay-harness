# Mobile remote

English | [中文](README.zh.md)

Scanning the QR code in the desktop **Remote** dialog opens this directory's independent `mobile/web` SPA, not the official four-column `rlh web` UI.

## Web

1. Open Remote on the desktop and select LAN or HTTPS relay mode.
2. Scan with the system camera or browser. The secret remains in `#offer=`.
3. After login on port 3180 or the relay, the server returns this directory's `index.html`; `/api/*` and WebSocket traffic still proxy to local `127.0.0.1:3080`.
4. During development, `pnpm run test:desktop` runs `mobile/web/**/*.test.js`.

The relay must use HTTPS. Traffic passes through the relay operator; this is not end-to-end encryption for session content.

## Android

In-app scanning and native screens are not implemented. Use the system browser for the pairing link; do not wrap the official UI in a WebView.
