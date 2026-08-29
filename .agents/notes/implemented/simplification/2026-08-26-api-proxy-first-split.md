# Agent Note: api-proxy first split

Status: implemented

English | [中文](2026-08-26-api-proxy-first-split.zh.md)

## Problem

`packages/host/apiproxy/src/api-proxy.ts` had grown to 3,749 lines mixing at least eight domains behind one module: RPC envelope plumbing, prompt-content image admission, session-list projections, workspace conflict vocabulary, and the entire `createApiProxy` handler body. Every domain change landed in the same file, review diffs collided, and the file anchored the api package cycle as both its largest runtime module and the client face's consumed surface.

## Decision

A first cut moves the four lowest-coupling helper clusters into focused modules beside the existing `src/api/` contract layer, leaving `createApiProxy` and its handler body untouched:

- `src/rpc-envelope.ts` — `ok`/`err` result wrapping, `frame` minting, `isAborted`, `MESSAGE_TYPES`, and message-boundary `paginate`.
- `src/prompt-content.ts` — `durablePromptContent` batch image admission and the durable-event image search (`messagesHaveImage`, `referencedImage`).
- `src/session-list.ts` — `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES`, the exact-metadata fold (`applySessionListMetadata`, `sessionListMetadata`), `sessionListFields`, `summarize`, and the size-gated cold probes (`summarizeCold`).
- `src/workspace-views.ts` — the preset/cwd/name conflict classes, `presetError`, and the workspace wire projections (`workspaceNotFound`, `workspaceView`, `changedWorkspaceView`).

A second cut the same day moved four more clusters: `src/model-catalog.ts` (`buildModelCatalog`), `src/frame-queue.ts` (`FrameQueue`, `assertJsonArgs`, `subscribeSession`), `src/approval-questions.ts` (the pending approval/question entries and their validation), and `src/history-views.ts` (`viewFor`, `backscanArgs`, `historyPage`, `DEFAULT_MAX_MESSAGES`).

`src/index.ts` imports `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES` from `session-list.ts` directly; `api-proxy.ts` keeps no re-exports. The moves are code-identical: only imports, export keywords, and module doc comments changed.

## Alternatives considered

**Split the `createApiProxy` handler body by domain first.** That is the end state, but every handler closes over `ctx`, shared registries, and neighbor helpers; cutting there without the helper modules in place just scatters the coupling. Deferred until the helper seams exist.

**Leave the file alone until the cycle inversion lands.** The split and the [API package cycle inversion](../../proposed/architecture/2026-08-26-api-package-cycle-inversion.md) are independent: this cut reduces the file regardless of which direction the cycle work takes, and shrinking apiproxy makes the later handler split smaller.

## Consequences

`api-proxy.ts` drops to ~3,150 lines (both cuts) and its import surface shrinks by more than twenty now-module-local dependencies. The four new modules are single-domain files a reviewer can hold in one pass, and the session-list and workspace clusters now have an obvious home for their growth. The handler body remains a monolith; this note's scope ends at the helper seams. The per-file coverage gate applies to the new modules unchanged — same tests exercise the same moved code.

## Testing

`npx tsc -b` on the package project and the host aggregate both pass; the full apiproxy suite (20 spec files, 389 tests) passes unchanged, which is the point of a code-identical move.
