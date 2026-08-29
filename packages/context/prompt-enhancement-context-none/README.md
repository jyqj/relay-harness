# @relay-harness/rlh-prompt-enhancement-context-none

English | [中文](README.zh.md)

Explicit draft-only Context provider for tests and deployments that deliberately disable contextual retrieval. It registers one provider returning an empty prepared message list. The shipped Web composition does not use this adapter; selecting it is an explicit deployment decision, never a silent fallback for a missing Context Engine.

## Model Experience

### Draft-only enhancement

#### What the model sees

With `messages: []`, the Prompt Enhancement model receives only the enhancement provider's stable instruction and exact draft because this adapter contributes zero messages.

#### Token effect

Zero context-message tokens; the enhancement provider's request still consumes its own prompt and output tokens.

#### KV Cache effect

The independent auxiliary request changes only with the provider instruction and draft.

## Known Limitations and Deferred Work

- This adapter intentionally provides no files, memory, session history, code evidence, coverage, or context trace beyond the empty selection.
