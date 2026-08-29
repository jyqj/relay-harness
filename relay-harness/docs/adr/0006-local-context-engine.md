# ADR-0006: Local Context Engine (Indexing and Retrieval Never Use Cloud Storage)

English | [中文](0006-local-context-engine.zh.md)

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Relay needs deep context across code, sessions, memory, attachments, and other sources. The reference system Auggie (ACE) uses a cloud topology: the client inventories and hashes files, while cloud services perform indexing, embedding, and reranking and the client retains only checkpoint pointers. This conflicts with Relay's established principles: ADR-0004 requires local state and least privilege, while the root README makes model routing external and files explicit context rather than an implicit whole-device scan.

The repository already has local domain capabilities: session-query with recursive-indexing defenses, memory with revision and trust governance, the LSP seam, and a local code-index implementation designed for deterministic offline lexical and graph retrieval. The missing piece is a control plane and shared Evidence protocol connecting those engines.

## Decision

1. Relay provides a local Context Engine. Source registration, retrieval orchestration, Evidence admission, packing, and tracing happen on the user's machine; cloud services perform only explicitly routed model inference.
2. **Source content never leaves the machine for indexing, retrieval, or ranking.** Only user-visible model-request content may leave the machine.
3. An index is a deletable, rebuildable derived cache and never a source of truth. Local files, session logs, and Memory revisions remain authoritative.
4. A retrieval result must become revision-bound Evidence before entering a model request; raw search hits cannot be appended directly to a prompt.
5. Retrieval failure, index degradation, or read errors must not silently appear as “no result.”
6. Injected context, including recall/context messages, must not be indexed again as new Evidence, preventing recursive contamination by derived content.
7. Raw scores from different domain providers are not directly comparable; global selection uses provider-local rank plus calibration policy.
8. The runtime records retrieval traces; an agent cannot attest to its own coverage. Negative conclusions require a Coverage record.
9. Prompt rendering happens after context packing. Source content carries no instruction authority.
10. The first generation introduces no embedding/vector dependency. A semantic retrieval lane is `[Decision pending]` until local evaluation justifies it, and any model and vector storage must remain local.

## Alternatives considered

- **Cloud indexing (ACE topology):** cloud compute may improve retrieval, but source data leaving the machine violates ADR-0004. Rejected.
- **Continue adding plugins under `packages/context/`:** pre-request text-injection plugins alone do not provide Source/Revision/Evidence ownership or a control plane. Rejected.
- **A thin provider exposing only CodeCortex search:** this would erase graph, impact, test, and degradation capabilities. Rejected; a code-native capability remains complete behind a transport-neutral adapter.

## Consequences

- Privacy is a first-class product property: “indexing works, but your files never leave the computer for indexing.”
- Ranking depends on deterministic local lexical, graph, structural, and explicit-reference signals without a cloud reranker; local evaluation must continuously validate recall.
- File-count limits, watcher/agent CPU contention, and visible disk use become product responsibilities.
- Runtime-fact plugins such as time remain in `packages/context/`; task retrieval and packing belong to the Context Engine control plane described in [`../agent/context-engine.md`](../agent/context-engine.md).

## Clarifications

**Item 6 — compaction-checkpoint corpus boundary.** Three direct defenses exclude recall messages (`form: 'recall'`) from session-query corpus extraction, memory extraction, and session-reference projection. An indirect path remains: after compaction, a checkpoint summary (`kind: 'plugin'`, without a recall marker) may restate paths and excerpts and later enter the session-query corpus. This does **not violate item 6**. A checkpoint is an aggregate derivative of the complete conversation interval, including assistant replies, and has the same Evidence level as an assistant reply; either may restate facts from the conversation. Item 6 prohibits the self-amplifying loop that re-indexes injected context verbatim as independent Evidence, and the three direct entries block that loop. Recall content also originates from the user's local code index, so incorporating it into the conversation narrative does not create belief beyond the session. [`../subsystems/code-index.md`](../subsystems/code-index.md) records this boundary under Known Limitations. Corpus weighting or cross-session promotion of checkpoint summaries must reopen this decision.

**Item 10 — semantic-lane status.** Lexical/graph retrieval and the AST symbol graph complied with the original “no embedding/vector dependency” decision. A later semantic-vector layer was approved during design review rather than triggered by the local evaluation anticipated here; evaluation remains required. Vector storage stays in the local derived SQLite database as quantized int8 columns. The existing model-request exception in item 2 narrows “the model stays local” as follows: an embedding model may be called through ADR-0002 user routing, and chunk text leaves the machine as model-request content. This is the same egress category as conversational inference, not a new category. No local embedding-model dependency exists; without a configured route the semantic lane is absent and lexical/graph retrieval remains available.
