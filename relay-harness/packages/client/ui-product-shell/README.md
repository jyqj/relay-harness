# Client Product Shell

English | [中文](README.zh.md)

Chat, Work, and Library occupy the main workspace. The product navigation contributes to `sidebar.primary`, leaving workspace browsing, session search, and New Session available in all three views. Work and Library register keyed `shell.page` entries owned by [ui-layout](../ui-layout/README.md); neither replaces the conversation slot or declares a second conversation renderer.

## Main workspace

Chat remains mounted when another page is selected. Visited main pages also remain mounted and receive `active`; hidden pages cancel page-specific reads and ignore late replies without discarding unsent editor drafts. Main navigation is viewing state, independent from execution permissions and persisted display density. Supported product routes survive reload through the URL; invalid source addresses remain explicit rather than selecting another Session. Removed plugin page keys still fall back to Chat.

Work presents the current Session's goal, execution, synchronization, pending input, execution relationships, and recorded changes. The attention action opens that exact Session's existing conversation, where the established approval and question controls remain authoritative. It does not grant permissions or answer questions automatically. Direct-child navigation uses the existing subagent address when available, and a child can return to its parent. Background Jobs retain their separate status meanings; an inactive child is not displayed as successful. The page does not dispatch, retry, or cancel unsupported execution kinds.

Recorded changes come from the Host's whole-session `deliverables` projection rather than the loaded chat page. They are tool-recorded paths, not verified final artifacts. Missing historical capture remains explicit. Opening sends the source Session and exact path to the [Host](../../host/work-results/README.md); the browser neither rewrites relative paths nor assumes the selected workspace owns a historical output. The Workspace files action includes the current Session address, and the surfaces receiver rejects a request for a different selected Session.

## Review and synchronization

Execution, goal phase, pending input, and user confirmation are independent facts. A Goal is not required to review a closed Session record. Quiet, synchronized Work views read `workResults/review` before enabling confirmation. The Host returns every current eligibility blocker, including non-root Session, an open turn, queued input, pending interaction, or background work. Read failure leaves confirmation disabled with a recheck action. Those reasons explain the observation; the Host revalidates the actual mutation inside maintenance.

Confirmation binds a Session log prefix, not passing tests, file hashes, permissions, or completion of every child. Raw receipt projections never prove persistence. The displayed confirmation requires a verified current cut whose accepted revision matches the current projection. Work also requires a synchronized Connection and an open, non-removed history window before opening outputs or confirming a record. Disconnect, synchronization, history errors, and removal keep retained facts readable but unavailable for these operations. Verification and operation replies belong to the Session, handshake epoch, and active-page lifetime; switching any of them invalidates late replies. Reconnection never resends writes.

## Library and display density

Library searches bounded pages of execution-recorded outputs across existing Sessions, without scanning device files or activating cold owners. Each row opens its source output or explicitly navigates to its source conversation. Files and knowledge are distinguished from capabilities and connections, with copy stating which actions use the selected Session.

Missing capture and unreadable-Session notices survive pagination. Numeric coverage remains per-page because a Session can span multiple pages; the final cursor does not erase earlier gaps. Failed-page retry preserves the submitted query and cursor; restart replaces the scan. Reconnection or reactivation reloads the submitted query from its first page while preserving the unsubmitted search draft. Previous-epoch rows remain disabled until the new scan returns. Read and native-open errors stay independent.

Detailed view controls advanced configuration and diagnostics, not execution access. Persisted `simple` and `developer` values remain unchanged. Simple display suppresses model, preset, plugin, and trajectory controls but preserves evidence inspection. Mode reload waits for pending local writes; disposal invalidates generations and prevents late native mirroring.

## Model Experience

### No direct model request

#### What the model sees

Nothing from this package. Product navigation and projections do not submit a model request. Explicitly continuing a conversation uses its existing input path.

#### Token effect

Zero tokens for viewing or navigation; no Session event is added by a view change.

#### KV Cache effect

None. Display density does not alter model history or tool permissions.

## Known Limitations and Deferred Work

- Work describes the selected Session and its direct execution relationships, not an exhaustive cross-workspace task inbox or durable independent Task entity.
- Confirmation is transcript-bound. Artifact versions, automated test attestations, and whole-subagent-tree acceptance require separate domain support.
- Library has no workspace filter, and native output opening remains limited by Host capabilities and authorization.
- Product mode has no Host push event; local successful writes and reconnect reads update the browser.

## Source records and URL navigation

Library output sources and Work activity open the read-only `record` page instead of implicitly opening/resuming a conversation. `#relay/record/<encoded-session-id>` identifies that source; official conversation, Work and Library views also participate in browser history. Invalid routes stay invalid, and URL navigation never supplies authority or activates a Session. Only the explicit conversation action enters the existing interactive path; delegated records route through their owner.

Record reads are bound to route, page activation and connection epoch. Hidden, disconnected or superseded reads are aborted and late completions cannot replace another source. History pages retain a prefix-bound snapshot. Goal phase, execution, recovery capability, source cut and coverage remain separate. This page is not a second task store, global approval inbox, content-version review system or provider-health dashboard. Live Work confirmation uses the non-activating `workResults/review` endpoint.
