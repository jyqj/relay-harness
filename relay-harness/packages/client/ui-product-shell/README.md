# Client Product Shell

English | [中文](README.zh.md)

Shared browser product shell for the Chat, Work, and Library navigation model. The browser entry exports only `apply` and `inject` as values; visibility policy remains internal.

Simple Mode suppresses advanced model/preset/plugin/trajectory controls but keeps the Context Inspector provenance surface visible. Work reads existing Goal, Plan, Jobs, Trajectory, Deliverables, Approval, Question, and Session projections; Library opens the existing Files and governance Settings surfaces. Deliverable opening passes the source Session and exact execution-recorded path to the [Host](../../host/work-results/README.md) for inventory and path checks; the browser does not rewrite paths or impose the currently selected workspace as their root.

Work's deliverable inventory comes from the Host's whole-session `deliverables` projection, never the loaded chat timeline. Missing capture in older successful results is shown as incomplete history; an absent projection is shown as unavailable. The trajectory counter explicitly counts loaded records. Execution, Goal phase, pending human input, and review are independent facts. Failed and killed Job counts describe the visible Job list, not the overall task outcome. Work identifies its workspace and Session and highlights reviewable records even without a Goal. Equivalent Work facts retain snapshot identity during streaming. File-open failures stay in-page with retry and dismissal, and settlements from a previous Session cannot reopen the error.

Work separates execution status from explicit confirmation of a Session log prefix. Raw receipt projections trigger invalidation or verification but never prove persistence. Quiet views read `workResults/get`; its verified cut, successful acceptance response, cancellation, and late-response checks prevent an unsaved or superseded receipt from displaying as current. Library searches bounded pages through the Host and opens each row using its source Session identity, with explicit incomplete-history and continuation notices. The confirmation does not prove tests, file versions, permissions, or completion of every child.

Work requires both the Connection's synchronized handshake and an open, non-removed Session history window before enabling result confirmation or file opening. Retained records remain visible with an unavailable-state explanation during disconnection, synchronization, history loading, failure, or removal. Each new handshake advances an epoch; verification belongs to that epoch even when the Session and log revision are unchanged. Superseded command and verification replies cannot publish into a replacement connection. Connection readiness does not assert that every optional provider or unrelated Session has loaded successfully.

Library preserves observed missing-capture and unreadable-Session facts across successful pages of one scan. Numeric counts remain per-page because one Session can span several path pages. Reaching the final cursor does not clear earlier gaps. Failed-page retry preserves the submitted query and cursor; restart discards accumulated outputs and gaps. On reconnection the browser repulls the submitted query from the first page instead of reusing a stale cursor or submitting an unfinished editor draft. A new handshake's outputs cannot be opened until that scan has returned. Read failures and native-open failures remain independent.

Mode reloads wait for locally admitted writes to settle before reading the Host, including when persistence rejects. This prevents a connection reset from publishing a pre-commit value over a pending choice. Mode operations belong to the plugin instance lifetime. Unloading blocks new operations immediately; disposal invalidates pending generations permanently. Late replies cannot publish mode changes or begin native mirroring after that lifetime ends.

## Model Experience

### No direct model request

#### What the model sees

Nothing from this package. `productMode`, Work, and Library are browser projections over existing Host and Session state.

#### Token effect

Zero tokens. Changing the product shell never appends a Session event or prepares model context.

#### KV Cache effect

None. The shell changes visible controls and navigation without changing a model request or cache prefix.

## Known Limitations and Deferred Work

- The sidebar remains the current top-level navigation host; Work and Library are compact sidebar pages rather than independent center-column routes.
- Product mode has no Host push event yet. Successful writes fold locally, and reconnect reloads the persisted value.
