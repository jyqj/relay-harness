# Agent Note: Ship Context Inspector and Code Index Center

Status: implemented

English | [中文](2026-08-29-context-inspector-and-code-index-center.zh.md)

## Problem

Durable `context/prepared` traces and BuildExplain/index-generation status existed, but users could not inspect them. The browser rendered model-visible context messages without the attribution, rejected links, freshness, verification, truncation, or coverage carried by the durable trace. Code-index maintenance required internal calls and exposed no file/chunk/generation/backlog view, safe reconcile action, approval-gated rebuild, or bounded search diagnostic.

## Decision

`@relay-harness/rlh-context-inspector` registers a whole-log Session Projection. It folds exact `user/message` facts and `context/prepared` events into the latest 50 step traces, retaining admitted links and rejected/rewritten empty links, evidence source/key/path/revision, why-used reasons, freshness, verification, truncation, and coverage. Message facts are bounded at 500 and previews at 240 code points. The browser plugin occupies the additive conversation-header utility slot and opens a modal drawer; Chat ownership and message rendering remain unchanged.

The code-index seam adds an operator management projection and reconcile verb. The local provider reports file/chunk counts, epochs, BuildExplain, embedding generation identities, coverage, pending/running/failed jobs, and bounded last errors. `@relay-harness/rlh-host-code-index-center` exposes typed status/refresh/reconcile/rebuild/search Remotes. Debug search is capped at 500 query characters, 20 paths, and top-K 20 and never hydrates source. Rebuild requires the exact `REBUILD` token on the Host; the Client independently requires typing it in a confirmation modal.

The Code Index Settings page uses a connection-scoped status cache and renders health cards, generations, coverage/backlog/errors, raw bounded BuildExplain, maintenance actions, and compact debug hits. Web composition now ships the local provider, code-context contributor, Context Inspector projection, Host Remote, and both Client surfaces. Desktop shares this Web build, so no parallel desktop UI exists.

## Alternatives considered

- **Read raw browser Session events directly** — rejected because raw windows are paging-bounded and not part of the public Session face; a Host whole-log projection survives paging and cold reopen.
- **Add fields to chat nodes** — rejected because attribution is log-only observability and would couple generic conversation rendering to Context Engine vocabulary.
- **Expose force rebuild as an unguarded Remote** — rejected because a browser bug or stale click could erase the derived store without explicit intent.
- **Hydrate debug-search snippets** — rejected because the Center diagnoses retrieval and must remain output-bounded; source admission stays in the hydration seam.

## Consequences

Users can inspect what was used, why, its revision quality, where coverage stopped, and which proposals did not reach the model. Operators can observe and repair the default index without developer tools. The Context projection intentionally omits bodies older than 50 traces. The Center now resolves Host Session cwd through the workspace router, so its status, debug search, and maintenance operations are Session-scoped rather than hidden process-wide UI state.
