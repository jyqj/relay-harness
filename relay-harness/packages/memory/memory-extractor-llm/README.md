# `@deepseek-ai/dsh-memory-extractor-llm`

English | [中文](README.zh.md)

Durable, evidence-grounded automatic memory extraction. After a completed or max-token turn, the capture path projects only direct user messages and successful tool results into a bounded source snapshot, then idempotently enqueues it on `ctx.memoryExtractionQueue`. A host worker claims jobs with persisted leases and retries, calls one auxiliary LLM, strictly validates its JSON proposals, and writes governed revisions through `ctx.longTermMemory`.

The package default is disabled. The shipped base composition explicitly enables it only for `standard` sessions and excludes delegated subagents. Derived recall/plugin messages, reasoning, failed tool results, memory/session/skill tool results, and secret-bearing sources are never admitted. Successful results from an allowlisted local tool are `action-verified`; other successful results remain external observations.

An automatic memory becomes `active` only when `evidence_quote` is an exact contiguous excerpt from a direct user message or action-verified tool result. Its persisted content is that exact quote, never the model paraphrase. External or ungrounded proposals remain candidates; malformed output retries the durable job. Exact normalized kind/content deduplication makes partial retry safe.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `enabled` | `false` | Registers capture and worker behavior only when explicit. |
| `userId` | `local` | Stable user Scope for extracted memories. |
| `agentId` | `deepseek-harness` | Stable Agent Scope shared across sessions. |
| `workspaceId` | session cwd, then `global` | Optional explicit workspace Scope. |
| `agentPresets` | `[]` | Durable preset allowlist; empty accepts every preset. |
| `includeSubagents` | `false` | Whether delegated sessions are captured. |
| `provider`, `model` | current session route | Optional paired auxiliary route override. |
| `verifiedToolNames` | local file/shell tools | Successful-result names allowed to produce action-verified evidence. |
| `maxInputChars` | `16000` | Complete system-plus-user extraction input cap. |
| `maxSourceChars` | `4000` | Exact prefix cap for each admitted source. |
| `maxCandidates` | `5` | Largest accepted proposal array. |
| `maxCandidateContentChars` | `2000` | Largest proposed content. |
| `maxCandidateSummaryChars` | `300` | Largest proposed summary. |
| `maxOutputTokens` | `1200` | Auxiliary response token cap. |
| `timeoutMs` | `60000` | End-to-end extraction call deadline. |
| `maxAttempts` | `3` | Durable attempt cap per source hash. |
| `leaseMs` | `120000` | Worker claim lease; must exceed `timeoutMs`. |
| `retryDelayMs` | `5000` | Delay after a failed attempt. |
| `pollMs` | `1000` | Idle queue polling interval. |

## Model Experience

### Auxiliary memory-extraction request

#### What the model sees

A separate request with `purpose: 'memory-extraction'` receives a fixed JSON-only instruction and a tag-safe JSON array of bounded source snapshots. Each item carries its source kind, event seqs, verification class, optional tool name, and exact text. The model has no tools and does not receive conversation history, recalled memory, or reasoning blocks.

#### Token effect

The auxiliary call is bounded by `maxInputChars` and `maxOutputTokens`. It adds no text to the main Agent history; accepted revisions may affect a later turn only through `memory-agent` recall.

#### KV Cache effect

No main-request invalidation. Auxiliary requests reuse only the provider-specific fixed system prefix; source JSON changes per completed turn.

## Known Limitations and Deferred Work

- **One process-local worker** — jobs survive restart, but the shipped SQLite provider supports one live process owner rather than distributed workers.
- **Character rather than tokenizer input budget** — the complete cap is deterministic across providers but is not an exact token count.
- **Exact dedup only** — semantically equivalent paraphrases are not merged without a later review or semantic provider.
- **No review surface yet** — external and ungrounded candidates are durable but require tools or a future UI for promotion.
