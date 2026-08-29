# Prompt Enhancement

English | [中文](prompt-enhancing.zh.md)

## 1. Product behavior

Prompt Enhancement is an **explicit user action before submission**:

1. The user writes a draft in the input box.
2. The user clicks `Enhance`.
3. The system prepares dedicated context and requests an improvement.
4. The proposal returns to the input box after review.
5. The user continues editing, undoes the change, or submits explicitly.

Clicking `Enhance` does not send a message, create Work, or execute a tool.

## 2. Reasonable context

Chat and Work share one Context Engine. See [`prompt-enhancing-context-pipeline.md`](prompt-enhancing-context-pipeline.md) for history projection, hydration, file retrieval, Rules/Guidelines, and empty-history semantics.

The Context Engine selects only content directly relevant to the current draft:

| Source | Use rule |
|---|---|
| Current draft | Required; preserve the core intent |
| Current session | Select excerpts that resolve references or supply confirmed constraints |
| Current Work | When present, use only its goal, current state, and relevant steps |
| File Context | Use names, types, user notes, and relevant summaries; read bodies on demand |
| Long-term memory | Use only relevant, permitted, unexpired information |
| Capability description | May explain available output forms and acceptance methods |

Unrelated sessions, complete history, files not introduced by the user, and unrelated memory cannot enter the enhancement request.

## 3. Output contract

```yaml
enhance_result:
  enhanced_draft: string
  assumptions: [string]
  unresolved: [string]
  context_refs: [string]
```

The UI proposes `enhanced_draft` through a diff; assumptions and unresolved items remain inspectable. Content without contextual support cannot be presented as fact.

## 4. Improvement goals

- Clarify the goal and expected artifact;
- add constraints already established by context;
- replace ambiguous references with understandable wording;
- add acceptance requirements when needed;
- preserve the user's language, tone, and original intent;
- never expand task scope unilaterally.

## 5. Interaction requirements

- Restore the original draft with one undo action;
- a later click enhances the current input value;
- enhancement failure leaves the original draft intact;
- disclose source categories when files or memory were used;
- sensitive content follows the current session or Work data boundary.
