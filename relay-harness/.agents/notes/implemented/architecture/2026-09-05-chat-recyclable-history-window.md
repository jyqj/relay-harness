# Agent Note: Chat recycles viewport rows and exposes full loaded history explicitly

Status: implemented

English | [中文](2026-09-05-chat-recyclable-history-window.zh.md)

## Problem

An expand-only tail window bounds initial rendering but eventually mounts every loaded row. Blind row eviction destroys expanded tool state, text selection, and keyboard focus; browser find cannot search unmounted DOM. Mounted-row counts also cease to describe history paging once rows are recycled.

## Decision

Chat uses the already-adopted TanStack variable-height virtualizer over stable per-Session node keys, with measured row heights and the existing shared scrollport. It recycles in both directions without deleting loaded history. The existing bottom-follow, prepend-anchor, and semantic-remount ownership remain in ChatView; nested anchors record their containing node for virtual restoration. Retargeting clears interaction and measurement caches.

Expanded tools, selected text, and keyboard-focused rows remain keyed and mounted while the interaction persists. Their retained count is visible and explicitly additive to the viewport budget. Full loaded history is an explicit mode, reachable by a control or Ctrl/Cmd+F, that mounts all loaded rows for native find and long selection. It never silently fetches or claims to search unloaded history; Load earlier remains available.

Loaded node/turn diagnostics describe the data window, not DOM occupancy. Browser paging and performance probes use those diagnostics; separate structural assertions bound the default mounted set plus user-held rows.

The real-browser prepend contracts exposed a second scroll owner: the virtualizer compensated prepend and row measurements independently of ChatView's semantic anchor ledger. Virtualization now owns geometry only; ChatView compensates measured commits and attributes reader scrolls before range listeners run. A large jump captures its semantic cut after the new range mounts. The 2-pixel browser tolerance is unchanged. A controlled virtual-prepend regression joins the existing recycling and interaction cases; browser verification of this correction requires a rebuilt artifact.

Pointer-down and focus on a row control capture that row as the reader anchor before virtualization reacts to focus. Opening a disclosure also leaves tail-follow ownership, so its newly revealed content does not pull the control away from the pointer. Copy and branch retain their original handlers and native effects; browser verification checks the actual clipboard rather than substituting a successful write.

## Alternatives considered

**Keep widening the tail window.** DOM growth remains proportional to history after repeated paging.

**Evict every off-screen row unconditionally.** Local tool disclosures, active selection, and focus would disappear.

**Claim native find covers the virtual list.** Browser search sees mounted DOM only. The explicit full-history mode states its loaded-data scope and its intentional unbounded DOM cost.

## Consequences

Conversation data, input semantics, and Host authority do not change. User-pinned rows and full-history mode are deliberate exceptions, not a claim of constant memory under arbitrary user actions. Unit regressions cover bidirectional recycling, paging, per-Session reset, native-find mode entry, selected text, and stateful tool expansion. Existing browser geometry contracts cover anchoring and remounts; the assembled long-interaction scenario and benchmark add structural budgets and native find/selection/tool checks. Browser results require freshly built artifacts and are reported separately from unit passes.
