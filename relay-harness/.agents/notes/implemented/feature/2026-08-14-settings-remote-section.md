# Agent Note: Remote pairing lives on a phone control beside Settings

Status: implemented

English | [中文](2026-08-14-settings-remote-section.zh.md)

## Problem

A Settings → Remote page with ports, LAN addresses, raw pairing URLs, and token rotation taught a technical pairing flow. Users need to turn remote on, pick LAN or a server relay, and scan a QR. Burying that in Settings made the control look unfinished and hid the only thing a phone user must see.

## Decision

Remote's dormant UI implementation is a desktop-gated `sidebar.footer.action` (`id: 'remote'`) in `@relay-harness/rlh-client-ui-settings-remote`, designed beside the Settings gear with On/Off, LAN/relay, pairing QR, and connected-device controls. It is not part of the shipped composition: the web-app patch comments out `ui-settings-remote`, the desktop preload exposes no Remote methods, `REMOTE_FEATURE_ENABLED` and `remoteAvailable` are false, and the main process constructs only `createDisabledRemote()` rather than `RemoteGateway` ([desktop composer draft lookup and official triggers](../bug-fix/2026-08-21-desktop-composer-draft-and-official-triggers.md)). No Remote control or network entry is user-reachable.

## Alternatives considered

**Keep the full Settings → Remote page.** Rejected: that page leaked gateway internals to every pairing. The gear remains for product settings; Remote is a pairing action.

**Put the control in Electron chrome.** Rejected: the official sidebar already owns the Settings trigger; a second chrome button repeats the pairing-window mistake.

**Bind `rlh web` to `0.0.0.0` or rebuild a native chat client.** Rejected: the Host fence has no auth, and the product wraps the official page.

## Consequences

Dormant package tests retain the proposed control behavior without composing it. Shipped-composition tests require the row to remain commented, Desktop config/IPC tests require unavailable and disabled projections, and the title bar, tray, preload, and settings expose no Remote entry.
