# @relay-harness/rlh-prompt-enhancement-llm

English | [中文](README.zh.md)

Model-backed provider for `ctx.promptEnhancement`. It preserves the user's intent, language, scope, constraints, and requested output while asking the auxiliary model for strict JSON containing `enhancedDraft`, `assumptions`, and `openQuestions`. The call receives the shared Context Engine messages unchanged, adds one JSON-framed draft message, exposes no tools, executes outside AgentLoop, and never submits or mutates the Agent.

The provider selects a paired explicit route when configured, otherwise the live Agent route and then its logged request route. It bounds the complete system-plus-message request and the raw output stream in UTF-8 bytes, composes caller cancellation with a deadline, rejects tool calls and non-stop finishes, validates every complete-result bound, and appends `prompt-enhancement/llm-request` before dispatch so every model-visible input is durable without entering ordinary derived history.

## Configuration

`provider` and `model` are optional but must be supplied together. `maxInputBytes`, `maxOutputTokens`, `maxOutputBytes`, `timeoutMs`, `maxDraftChars`, `maxListItems`, and `maxItemChars` own all deployment-varying limits.

## Model Experience

### Auxiliary enhancement request

#### What the model sees

The model sees the prepared Context Engine messages, the stable instruction in `PROMPT_ENHANCEMENT_SYSTEM_PROMPT`, and one JSON object containing the exact unsent draft. It has no tool schemas.

#### Token effect

The independent request is capped by `maxInputBytes`, `maxOutputTokens`, and the incremental `maxOutputBytes` stream guard. Its result adds no main-history tokens until the user submits a replacement draft.

#### KV Cache effect

The stable system instruction may be reusable within the auxiliary route; prepared context and draft changes affect only that auxiliary request.

## Known Limitations and Deferred Work

- The provider accepts JSON text rather than a provider-native structured-output mode, so malformed or fenced output fails and preserves the original draft.
