# @relay-harness/rlh-prompt-enhancement

English | [中文](README.zh.md)

Host Prompt Enhancement service and generated Remote namespace. `ctx.promptEnhancement` accepts one enhancement provider and one adapter from the shared Context Engine, then returns either a structured proposal or a `preserved` outcome carrying the exact original draft. Cancellation, missing providers, and provider errors never replace or submit the draft. The service rejects an oversized draft before context retrieval, losslessly detaches and bounds the complete Remote result, and exposes only explicitly client-safe capability errors; arbitrary provider messages never cross the boundary.

The context adapter receives the fixed `prompt_enhancement` purpose and returns already-prepared `UserMessage[]` plus an optional opaque `JsonValue` trace. This service never searches history, files, memory, indexes, or MCP resources and never defines a parallel context composer. A deployment missing either provider fails loud through a preserved outcome.

## Remote API

`promptEnhancement.enhance(agentId, draft, signal?)` resolves the target Agent through Typert. Successful output includes `originalDraft`, `enhancedDraft`, `assumptions`, `openQuestions`, model provenance, and the optional Context Engine trace. Clients own diff presentation, acceptance, undo, and cancellation.

## Model Experience

### Prepared enhancement request

#### What the model sees

The registered enhancement provider receives the exact draft and `UserMessage[]` from the shared Context Engine adapter's prepared messages. This service adds no prompt text of its own.

#### Token effect

The auxiliary request's token use is provider-owned. Its output and trace do not enter ordinary Agent history unless the user later submits the resulting draft.

#### KV Cache effect

The auxiliary call is independent of the main Agent request and does not alter its reusable prefix.

## Known Limitations and Deferred Work

- The outcome is request-scoped; a future Context Drawer may render its opaque trace, but this service does not persist UI acceptance state.
- Provider and Context Engine cancellation is cooperative. Registration disposal aborts and then drains captured attempts rather than declaring quiescence while provider work is still running.
