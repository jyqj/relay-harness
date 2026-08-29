# Product Experience: A Simple General-purpose Agent

English | [中文](product-experience.zh.md)

> See [`../feature-status.json`](../feature-status.json) for current implementation status and evidence. This page owns product semantics, not a completion inventory.

## 1. Default entry

The main interface exposes only entries users can understand directly:

- input box;
- file introduction;
- `Enhance`;
- `Send` or `Start Work`.

Models, routing signals, subagents, context budgets, and tool permissions do not appear in the default UI. Advanced settings expand on demand.

## 2. Prompt Enhancement

A user writes a draft and explicitly clicks `Enhance` **before submission**. Relay improves it from reasonable current context and presents the result for review:

1. It never starts automatically.
2. It never submits or starts execution automatically.
3. The user may continue editing, undo, or submit.
4. It does not change a core goal the user did not express.
5. Unconfirmed content remains empty or becomes a condition requiring confirmation rather than being invented.

Reasonable context includes the current session, files and summaries introduced to current Work, relevant permitted long-term memory, and Relay's current capabilities. See [`../agent/prompt-enhancing.md`](../agent/prompt-enhancing.md) for the detailed contract.

## 3. Chat

Chat supports direct questions, discussion, and forming a request:

- preserve current-session continuity;
- introduce files;
- use `Enhance` on unsent input;
- turn a formed request into Work without re-entering Project metadata.

## 4. Work

Work means “complete this,” not “create a project”:

- one goal creates one Work;
- files may be added before or during execution;
- Relay shows plain-language progress, confirmation needs, artifacts, and unfinished items;
- a user can leave and later recover long-running Work;
- after Work ends, the user may ask follow-ups, revise it, or create new Work from its result.

## 5. File experience

- Users drag or select files/folders without understanding workspace configuration.
- The UI continuously shows material the current Work may access.
- Large files expose structure and summaries first and bodies on demand.
- Input material and Relay-generated artifacts appear separately.
- Overwriting sources, deletion, external transfer, and publication require explicit confirmation.

See [`../agent/work-and-files.md`](../agent/work-and-files.md) for detailed design.

## 6. Long-term memory

Long-term memory reduces repeated explanation without creating invisible behavior:

- users can view, edit, and delete it;
- users can explicitly say “remember” or “do not remember”;
- memory use explains the category of long-term information referenced;
- memory unrelated to the current task cannot be injected;
- local governed Memory and Memory Center implement current behavior; multi-device sync remains later scope.

## 7. Progress, confirmation, and failure

- Progress uses user language such as “reading 3 files” or “checking results,” not internal class names.
- The system handles ordinary recoverable errors internally.
- When truly blocked, ask one critical question at a time.
- Explain the target, impact, and reversibility before confirming a high-impact action.
- Delivery distinguishes completed, partial, unverified, and user-action-required results.

## 8. Progressive capability

Templates, model strength, permission policy, tool details, and run logs may have advanced entries without blocking the default flow. Simplicity does not remove capability; it places complexity at the correct level.
