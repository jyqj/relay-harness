# Agent Note: Desktop preference effects and smoke isolation

Status: implemented

English | [中文](2026-09-06-desktop-preference-effect-and-smoke-isolation.zh.md)

## Problem

Saving an unrelated preference can change OS login registration if the complete resolved configuration is applied indiscriminately. An isolated smoke profile still shares the Electron application's OS login-item identity. An editable draft also does not prove that a Session is selected, so it is an invalid readiness signal for Session-scoped Git controls.

## Decision

The configuration IPC persists the normalized patch and applies login registration only when the patch explicitly contains `openAtLogin`. `RLH_SMOKE=1` bypasses OS login synchronization at startup and on configuration writes while retaining isolated configuration persistence. Normal launches retain startup synchronization.

The packaged workspace-connect walker explicitly requests a new Session after adding a Workspace, using the scoped action or the ordinary global action's recent-Workspace fallback. It observes a selected Session row and an enabled composer before declaring the workspace connected. An unsent editable draft alone is insufficient. Titlebar and PTY probes retain their real native handlers.

## Verification

IPC regressions distinguish theme writes, explicit login enable/disable, and smoke configuration writes. Source and packaged smoke entrypoints drive the real workspace picker, Session creation, titlebar hit targets, menus, and PTY echo without submitting a model-generation request or installing an application.

## Alternatives considered

Ignoring native login warnings would retain unrelated OS mutations. Disabling Git assertions would hide the missing Session setup. Bypassing Git's current-Session ownership in production merely to pass smoke would introduce another workspace authority.

## Consequences

Smoke does not verify platform login registration; its IPC unit tests verify delegation and isolation. Real login registration remains a separate platform integration concern. The ordinary product's configuration and Session ownership semantics are unchanged.
