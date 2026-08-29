# @relay-harness/rlh-client-ui-context-inspector

English | [中文](README.zh.md)

Conversation-header Context Inspector drawer over the `contextInspector` Session Projection. It shows step summaries, admitted and rejected contributions, linked messages, evidence source/path/revision, freshness, verification, truncation, coverage gaps, and why-used reasons without rewriting Chat.

## Model Experience

### No direct model request

#### What the model sees

Nothing directly. No `user/message` is added; this package observes or manages already-derived context/index state and never assembles a model request.

#### Token effect

Zero tokens directly. Later context retrieval may change only after an explicit index or governance operation.

#### KV Cache effect

No request-prefix or cache-key change is introduced by this package.

## Known Limitations and Deferred Work

- The drawer follows the projection bound and does not fetch omitted historical trace bodies.
