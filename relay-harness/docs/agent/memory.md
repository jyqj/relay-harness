# Long-term Memory: Implemented Governance and Product Boundary

English | [中文](memory.zh.md)

> The current implementation lives under [`packages/memory/`](../../packages/memory/README.md) and comprises local storage, governance states, outcome reconciliation, a Context contributor, and Memory Center. See [`../feature-status.json`](../feature-status.json) for exact status and [`../subsystems/memory.md`](../subsystems/memory.md) for runtime protocols.

## 1. Goal

Long-term memory reduces repeated explanation and lets Relay adapt to the user without retaining every conversation forever.

## 2. Memory categories

- Information the user explicitly asks Relay to remember;
- stable preferences such as language, format, and delivery method;
- user-confirmed background or long-term constraints;
- persistent matters that genuinely help later tasks;
- explicit prohibitions on remembering or requests to forget.

Work has no Project, so the initial product does not introduce “project memory” as a prerequisite. File and task state belongs to Work Context and does not automatically become long-term memory.

## 3. User control

- View, search, edit, and delete;
- support “remember this,” “do not remember this,” and “forget this”;
- support temporary sessions or not using memory for this request;
- disclose the category of memory that affects an answer or Prompt Enhancement;
- stop using deleted information from derived caches.

## 4. Use boundaries

- Inject only memory relevant to the current request;
- never treat an inference as a user fact;
- never let expired or conflicting content silently override newer information;
- do not create long-term memory from sensitive information by default;
- do not expand file or tool permission because memory exists;
- do not use memory for model training or agent-side routing optimization.

## 5. Relationship to Prompt Enhancement

Prompt Enhancement may use relevant, permitted, trusted long-term memory to supply known preferences and constraints, but it cannot expand beyond the user's expressed goal. The enhancement trace retains attributable memory-category references.

## 6. Later scope

- Continue evaluating common Web-product memory controls and interactions;
- tune automatic-memory policy further;
- improve product explanations for freshness, conflict, and confidence governance;
- multi-device synchronization remains unshipped while local storage is authoritative;
- multi-device sync, import, export, and migration;
- whether shared team memory exists and how it is isolated.
