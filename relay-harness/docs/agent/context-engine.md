# Local Context Engine

English | [中文](context-engine.zh.md)

## Current status

Context Engine is implemented under [`packages/context/`](../../packages/context/README.md). Code retrieval comes from [`packages/index/`](../../packages/index/README.md) in the same monorepo and does not depend on an external CodeCortex checkout. See [`../feature-status.json`](../feature-status.json) for completion evidence and these subsystem references for exact protocols and limitations:

- [`../subsystems/context-engine.md`](../subsystems/context-engine.md)
- [`../subsystems/code-index.md`](../subsystems/code-index.md)
- [`../subsystems/memory.md`](../subsystems/memory.md)

## Product constraints

1. Files, sessions, Memory, MCP resources, and code index each retain their source of truth; indexes are deletable, rebuildable derived caches.
2. Retrieval results become revision- and source-bound Evidence before entering a model request.
3. Source content carries no instruction authority; external resources are marked untrusted.
4. Retrieval failures, index degradation, insufficient coverage, and budget rejection remain visible rather than appearing as “no result.”
5. Raw provider scores are not compared directly across domains; Context Engine ranking and budget policy decide admission.
6. Recall and system injection cannot become independent facts again, preventing derived-content amplification.
7. The user's explicit workspace selection determines Code Index routing and isolation.

## Current capabilities

| Domain | Current implementation |
|---|---|
| File context | Explicit-reference hydration, size budgets, and missing/stale handling |
| Session history | Completed exchanges, checkpoints, and bounded history projection |
| Memory | Trust, conflict, outcome, usage coverage, and governed admission |
| Code Index | Workspace router, lexical/graph/optional-vector lanes, generation/epoch, dirty-closure degradation, and management center |
| MCP resources | Explicit-URI hydration only, retaining text/blob framing and untrusted-source marking |
| Prompt Enhancement | Shares Context Engine contributors with agent steps instead of maintaining a second composer |

## Privacy boundary

Indexes, derived databases, and vector storage remain local. Default Web composition has no embedding endpoint, so index construction does not leave the machine. If an administrator explicitly configures the optional semantic lane, bounded code chunks go to that endpoint for embedding and count toward provider usage. No configuration uploads the index database or complete workspace; final Context sends only content admitted through Evidence and budgets.

## Later scope

- Continue validating recall quality, latency, and degradation with a stable local evaluation corpus;
- deepen user-visible explanations for coverage, Evidence, and index generation;
- include semantic-lane model calls in the same user-visible routing contract after the external routing client ships.
