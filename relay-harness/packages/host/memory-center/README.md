# @relay-harness/rlh-host-memory-center

English | [中文](README.zh.md)

Host `memoryCenter` Remote over the canonical `ctx.longTermMemory` service. `list`, `search`, and `read` require an attached `sessionId`; the Host derives its durable cwd and rejects a Client-supplied `workspaceId` mismatch. Reads stay inside the resulting exact `(workspaceId, configured userId, configured agentId)` scope and never change recall-use accounting. Management pages can include expired, disputed, superseded, and tombstoned current rows. Detail reads return durable source evidence, `validUntil`-derived freshness, canonical signal/outcome history, and admitted Memory Evidence aggregated across the same-workspace Session Query corpus without Agent activation. Every use reports its admitted revision as current, historical, or unknown. Multi-page governance search retries a reordered snapshot and fails loud under repeated churn rather than returning skipped/duplicate rows. Conflict review combines canonical supersession and deterministic normalized-key findings before an optional attributed semantic detector.

`approve`, `reject`, `revise`, and `delete` require an attached session and the revision displayed when the user acted. The Host derives the mutation scope from that session's `cwd` (or `global`), appends a `memory/governance-requested` fact, requires the Session durability barrier to participate, rechecks the expected revision after that barrier, and only then cites its exact sequence as user-statement evidence in the append-only provider revision. Approval promotes only candidate/disputed rows and establishes `user-stated` trust; rejection and deletion append tombstones. No operation physically erases revision history or invents a retention policy.

## Model Experience

### No direct model request

#### What the model sees

Nothing. This package never assembles or sends a model request. The `memoryCenter` Remote only reads and mutates canonical Memory records.

#### Token effect

Zero tokens at management time. A later `memory-agent` request may admit a different Memory Context contribution after governance changes.

#### KV Cache effect

No request or cache prefix changes at management time. Later recall may change the non-prefix Memory Context message.

## Known Limitations and Deferred Work

- No semantic conflict provider is bundled; optional provider findings remain attributed candidates and never override user review.
- Work completion is positive outcome evidence for the latest prior recalled turn, not proof that one memory caused completion.
- Retention remains provider policy: the Center shows expiry and appends tombstones but never physically deletes revision history.
