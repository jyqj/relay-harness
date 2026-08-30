# Mobile remote

English | [中文](README.zh.md)

Phone Remote is deferred in the current desktop build. No Remote dialog is composed, `remoteAvailable` is false, and the main process opens neither the LAN gateway nor an outbound relay. This directory retains the independent `mobile/web` implementation and its unit tests as dormant assets; it is not a shipped network entry.

## Web

`pnpm run test:desktop` exercises `mobile/web/**/*.test.js` without enabling the feature. The dormant protocol expects a fragment-held offer, a local gateway, and an HTTPS relay, but none is constructed by the desktop entry point.

The dormant relay design requires HTTPS. Traffic would pass through the relay operator rather than provide end-to-end encryption for session content.

## Android

In-app scanning and native screens are not implemented. Use the system browser for the pairing link; do not wrap the official UI in a WebView.
