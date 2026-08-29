# @relay-harness/rlh-client-ui-prompt-enhancement

English | [中文](README.zh.md)

Composer control registered in `conversation.input.right`. A click calls the generated `promptEnhancement` Remote with the exact draft and cancellation, turns the busy control into an accessible Remote cancellation action, and opens an Original/Enhanced diff with assumptions and open questions. The proposal also projects admitted Context Engine Evidence as File, Code, Memory, History, or MCP source rows with the resource key, provider-owned selection reason, freshness, and verification state. Unknown or malformed opaque trace entries are not guessed. Only Accept replaces a draft whose value and monotonic `draftRev` still match the attempt, preventing ABA edits. Replacement uses the ordinary input transaction, so both the existing composer undo and the explicit Undo action restore the original under another revision CAS. Cancel, failure, mismatched Host output, session switch/removal, unmount, and stale results retain the draft, and the control never submits.

## Model Experience

### User-initiated enhancement

#### What the model sees

The control initiates the `promptEnhancement.enhance` Remote; the Host provider owns the separate auxiliary request and the trace facts, while browser UI state, source labels, and copy add nothing model-visible. The control is part of the ordinary composer in Simple and Developer modes.

#### Token effect

The control itself adds zero tokens. The Host provider owns the auxiliary request budget, and accepting a proposal does not add main-history tokens until the user submits it.

#### KV Cache effect

The control does not alter the main Agent request or its reusable prefix.

## Known Limitations and Deferred Work

- The proposal dialog renders a full removed/added draft diff rather than an inline word-level diff.
