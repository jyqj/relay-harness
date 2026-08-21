# Agent Note: Native workspace Session Tree

Status: implemented

English | [中文](2026-08-21-native-session-tree.zh.md)

## Problem

The Web client could fork a Session from a completed Turn, and durable headers already recorded `parentSession` plus `seedLength`, but no first-party surface exposed the resulting graph. The external Synapse experiment proved the value of a workspace canvas—branch visibility, pan/zoom, collapse, current-Session synchronization, and Turn cards—but used a fixed `document.body` control, an iframe and `postMessage` bridge, private HTTP routes, and a second JSON copy of Session messages and lineage. Pi's `/tree` added useful navigation semantics—current path, historical branch points, labels, filters, and rewriting from an earlier user message—but its single-file entry tree could not replace DSH's balanced append-only Turn/Step/Tool log and cross-Session lineage without spreading two parent models through persistence, SDKs, projections, and recovery.

## Decision

`@deepseek-ai/dsh-client-ui-session-tree` is a native browser plugin. A `conversation.session.header.actions` entry and a root `shell.titlebar.trailing` entry open a root-scoped `shell.overlay`, so selecting another Session updates the map without remounting it; the titlebar entry disables without a current Session. All registrations use ordinary slot injection and dispose with the plugin fiber. The package's private controller owns only transient open/anchor state; its declared root store persists viewport, positions, collapse choices, labels, filter, query, and selection.

Session facts remain elsewhere. `SessionSummary.seedLength` carries `SessionHeader.seedLength` through list baselines and `host/session-added`; `parentSessionId` remains the parent identity. The canvas reads the global Session and Workspace snapshots, excludes archived Sessions, includes descendants such as hidden subagents, and pages `session.history` without opening or resuming an Agent. A child projects only events at or after its `seedLength`; its first live card connects to the last parent Turn whose boundary is before the cut. Missing parents become roots. Cyclic lineage drops the cyclic parent edges and keeps every Session visible.

One Turn is one card. Direct `source.kind=user` text is the question, other user-role context is available only in the all-process filter, and assistant text is the answer. Tool calls and results pair by `callId` and stay folded with name, result text, and error state. The filters are `default`, `no-tools`, `user-only`, `labeled-only`, and `all`; search and labeled-only retain ancestor cards so the result remains navigable. Card coordinates are deterministic until the user drags a card, after which the store owns that card's position. Collapse hides the complete descendant graph, not just the next Session.

All business mutations delegate to existing services. Opening calls `ctx.sessions.open`. A historical branch calls `ctx.sessions.fork({ atSeq })`; rewriting calls `ctx.sessions.fork({ beforeSeq })`, then sends the replacement to the returned child. Continuation uses the existing Session prompt face. New Session and archive use `ctx.workspaces`. The UI never interprets whether an arbitrary seq is a legal cut; Host fork policy remains the only decision owner.

## Alternatives considered

**Vendor Synapse unchanged.** Rejected because its iframe, private transport, independent theme, and duplicated message store bypass the client slot and object-layer contracts.

**Register a session-scoped `conversation.view`.** Rejected for the workspace canvas: changing the current Session would change the view's scope and remount the map. The root overlay preserves camera and selection while Session focus moves.

**Create another lineage database or projection key.** Rejected because lineage is immutable header metadata spanning Sessions. `session-projection` owns values derived from one Session log, while persistence and SessionQuery already own live/cold headers.

**Adopt Pi's entry `parentId` inside one Session file.** Rejected because it would add a second ordering relation beside DSH Turn/Step balance and duplicate the existing cross-Session fork lineage. Historical navigation is represented as a child Session instead of moving a mutable leaf pointer.

**Write branch summaries automatically.** Rejected from this delivery. A summary that reaches the model is durable model-visible input and needs its own Session event and request-assembly policy. Tree navigation must not inject hidden context.

## Consequences

Web and Desktop share one native Tree implementation and the normal theme/slot lifecycle. Deleting browser layout storage loses only presentation choices; the complete business graph reconstructs from Session summaries and history. Forked prefixes retain provider KV reuse because the Tree changes neither prompts nor tools. Rewriting preserves the source log and creates an auditable child.

Opening the Tree currently reads complete histories for visible Sessions in 100-message protocol pages. This favors a complete graph over partial branch anchors; a later viewport-driven cache can reduce large-workspace traffic without changing the projection contract. Labels are presentation bookmarks stored with layout and do not roam between browser profiles.

## Testing

Host/client schema and manager suites pin `seedLength` transport beside `parentSessionId`. Pure model coverage pins inherited-prefix removal, tool folding, workspace descendants, archived exclusion, exact restored-fork anchors, cycle fail-soft, collapse, label filtering, and search ancestor retention. Slot coverage pins both native entries, controller handoff, fork delegation, and fiber disposal. Component coverage pins durable-history loading, Turn rendering, Session opening, completed-Turn fork, label persistence, and pre-Turn rewrite plus prompt. The assembled Web test covers bundle loading and the visible Session Tree action.
