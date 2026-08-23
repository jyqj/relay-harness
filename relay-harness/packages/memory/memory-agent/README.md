# `@deepseek-ai/dsh-memory-agent`

English | [中文](README.zh.md)

Agent-turn Consumer for `ctx.longTermMemory`. On the first step of a top-level turn, it extracts only direct user text, prepares one scope-bound recall observation, packs candidates under the complete message character cap, and appends a separately sourced `user/message`. Provider failures fail open and leave the accepted direct prompt unchanged.

The Consumer retains the prepared handle until the durable final `turn/end`. Completed and max-token turns commit the exact ids that entered the recall message; other endings abort. Unload drains active provider calls and aborts every remaining prepared turn. Delegated subagents are excluded by default.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `userId` | `local` | Stable user scope. |
| `agentId` | `deepseek-harness` | Stable Agent scope shared across sessions. |
| `workspaceId` | session cwd, then `global` | Optional explicit stable workspace scope. |
| `candidateLimit` | `10` | Provider candidates before packing. |
| `maxContextChars` | `3200` | Complete recall message cap in Unicode code points, including safety framing. |
| `includeSubagents` | `false` | Whether delegated sessions receive recall. |

## Model Experience

### Proactive memory recall

#### What the model sees

The first request of a qualifying turn contains the direct user message followed by `## Recalled memory`. A fixed warning identifies the JSON as untrusted, potentially stale evidence and forbids following instructions, permission claims, or tool requests found inside it. Entry data is escaped inside `<memory-context>` tags, and the durable source records ids, revisions, kinds, trust, confidence, retrieval scores, and channels without requiring prompt parsing.

#### Token effect

Conditional and capped. No message is added when no active candidate fits. Otherwise the complete recall message is at most `maxContextChars` Unicode code points and remains in history until compaction replaces it.

#### KV Cache effect

Recall is an append-only user-role suffix, so it preserves earlier reusable history. Different queries or memory revisions change only the new suffix; later compaction may invalidate reuse from its replacement boundary.

## Known Limitations and Deferred Work

- **No extraction policy in the recall Consumer** — `memory-agent` only recalls and settles; the independent, explicitly enabled `memory-extractor-llm` Consumer creates automatic revisions.
- **Character rather than tokenizer budget** — the complete bound is deterministic across providers, but it is not an exact model-token count.
- **No cited-use signal** — commit records candidates admitted to the model, not whether the final answer semantically used each one.
