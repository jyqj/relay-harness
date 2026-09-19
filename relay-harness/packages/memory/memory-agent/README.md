# `@relay-harness/rlh-memory-agent`

English | [中文](README.zh.md)

Context Engine provider over `ctx.longTermMemory`. For the first step of a qualifying top-level Agent turn, it extracts only direct user text, prepares one scope-bound recall observation, packs candidates under the complete message character cap, and contributes a separately sourced message with revision-bound Evidence whose digest covers the complete injected item payload and bounded coverage. AgentLoop logs the admitted message and `context/prepared` provenance. Provider failures fail open and leave the direct prompt unchanged.

The provider retains the prepared handle until durable final `turn/end`. Completed and max-token turns commit only ids whose exact proposed message survived admission according to `context/prepared`; other endings abort. Unload drains active provider calls and aborts every remaining prepared turn. A preparation that fails before pending ownership is also aborted, so fail-open rendering cannot leak provider handles. Delegated subagents are excluded by default.

For `purpose: prompt_enhancement`, the same contributor searches active, non-expired memories in the exact Scope and emits the same message/Evidence/coverage shape, but sets `recordAccess: false`: an unsent draft creates no prepared turn, access signal, Session event, or settlement state.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `userId` | `local` | Stable user scope. |
| `agentId` | `relay-harness` | Stable Agent scope shared across sessions. |
| `workspaceId` | session cwd, then `global` | Optional explicit stable workspace scope. |
| `candidateLimit` | `10` | Provider candidates before packing. |
| `maxContextChars` | `3200` | Complete recall message cap in Unicode code points, including safety framing. |
| `includeSubagents` | `false` | Whether delegated sessions receive recall. |
| `agentPresets` | all | Optional durable preset allowlist; the shipped host config selects `standard`. |

## Model Experience

### Proactive memory recall

#### What the model sees

The first request of a qualifying turn contains the direct user message followed by `## Recalled memory`. A fixed warning identifies the JSON as untrusted, potentially stale evidence and forbids following instructions, permission claims, or tool requests found inside it. Entry data is escaped inside `<memory-context>` tags, and the durable source records ids, revisions, kinds, trust, confidence, retrieval scores, and channels without requiring prompt parsing.

#### Token effect

Conditional and capped. No message is added when no active candidate fits. The allowance is `maxContextChars` tightened by the request budget: `min(maxContextChars, budget.maxChars, max(0, (budget.maxTokens - 4) * 4))`. Hits that exceed the remaining allowance decline with `budget_exhausted` in the Context Engine trace. The recall message remains in history until compaction replaces it.

#### KV Cache effect

Recall is an append-only user-role suffix, so it preserves earlier reusable history. Different queries or memory revisions change only the new suffix; later compaction may invalidate reuse from its replacement boundary.

## Known Limitations and Deferred Work

- **No extraction policy in the recall Consumer** — `memory-agent` only recalls and settles; the independent, explicitly enabled `memory-extractor-llm` Consumer creates automatic revisions.
- **Character rather than tokenizer budget** — the complete bound is deterministic across providers, but it is not an exact model-token count.
- **No cited-use signal** — the Memory Center shows model admission and downstream outcomes, but commit still cannot prove that the Assistant semantically relied on each admitted item.

## Explicit tool recall

`tool_retrieval` uses the same preset/subagent/scope gates and performs a read-only search of active governed memories with `recordAccess: false`. It does not prepare or commit a memory-use transaction and does not approve a candidate. Entries are independently selectable, source-attributed observations within the request budget. Retrieval failures are classified in the Context Engine trace rather than silently described as no memory.
