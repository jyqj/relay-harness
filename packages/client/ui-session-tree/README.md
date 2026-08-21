# @deepseek-ai/dsh-client-ui-session-tree

English | [中文](README.zh.md)

Native workspace Session Tree for the Web and Desktop surfaces. A per-session action in `conversation.session.header.actions` and a shared `shell.titlebar.trailing` action open a root-scoped `shell.overlay`; changing the current Session does not remount the canvas. The titlebar action disables itself when no Session is current. The overlay reads the global Session and Workspace snapshots, pages durable history without resuming Agents, and derives every card and connector from the current log plus `parentSessionId` / `seedLength`. The persisted store contains only viewport, card positions, collapse choices, labels, filter mode, query, and selection—never messages, titles, or lineage.

Each root Session forms a lane of Turn cards. A fork child omits its inherited seed and connects its first live Turn to the last parent Turn before `seedLength`. Orphans remain visible as roots and lineage cycles fail soft instead of dropping Sessions. Tool calls pair with results by `callId` and stay folded into their assistant Turn, including error state and result text. The five filters are `default`, `no-tools`, `user-only`, `labeled-only`, and `all`; search retains the ancestor path of every match.

The canvas supports pan, zoom, persisted drag positions, complete-subtree collapse, current-Session focus, Session opening, latest or historical Turn forks, pre-Turn rewrite forks, continuations, new Sessions, and archive. Fork cuts always delegate to `ctx.sessions.fork({ atSeq | beforeSeq })`; the browser never reimplements Host turn-boundary policy. Rewriting creates a child before the selected Turn and sends the replacement text to that child, preserving the source Session's append-only log.

## Model Experience

Indirectly, through the ordinary Session prompt path when a user sends a continuation or replacement from the Tree. The package adds no system prompt, tool, context, or automatic model request; the submitted text is exactly what the user entered, or the selected original question when the replacement field is empty.

#### KV Cache effect

Opening, filtering, labeling, and arranging the Tree do not affect provider requests or KV prefixes. A user-initiated fork reuses the selected durable prefix; a subsequent continuation behaves like the same action from Chat.

## Known Limitations and Deferred Work

- Layout and labels use browser `localStorage`; they do not roam between devices.
- Opening the Tree reads complete visible-Session histories in protocol-sized pages. Very large workspaces need a later viewport-driven history cache.
- Pi-style abandoned-branch summarization is not automatic. DSH preserves the old branch and forks from the selected stable Turn without adding hidden model-visible context.
