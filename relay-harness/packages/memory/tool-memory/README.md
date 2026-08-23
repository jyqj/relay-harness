# `@relay-harness/rlh-tool-memory`

English | [中文](README.zh.md)

Provider-neutral memory tools. Every call derives the exact user/workspace/Agent scope from the calling Agent. Search and read never widen it. Writes serialize per scope through a tool resource intent.

`memory_remember` activates a memory only when `evidence_quote` exactly occurs in a direct user message or successful tool result. Without that evidence, the provider receives an `agent-proposed` candidate, which proactive recall ignores. `memory_update` applies the same rule to content changes and activation. `memory_forget` requires an exact quote from a direct user deletion request before it can append a tombstone. Successful results of the memory tools themselves, other `session_*` projections, and `skill` output are derived state and never verify a write, mirroring extraction source exclusion, so recalled memory cannot launder itself into fresh evidence. The provider independently enforces active trust, evidence, and secret rejection.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `userId` | `local` | Stable user scope. |
| `agentId` | `relay-harness` | Stable Agent scope. |
| `workspaceId` | session cwd, then `global` | Optional explicit workspace scope. |
| `defaultSearchLimit` | `10` | Default `memory_search` result cap. |

## Model Experience

### Memory tool schemas and results

#### What the model sees

When this Consumer is present, the request tool catalog contains `memory_search`, `memory_read`, `memory_remember`, `memory_update`, and `memory_forget`; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) owns their exact schemas. Search returns compact metadata and content, read returns the complete current entry, and writes return the committed current revision as JSON text.

#### Token effect

The five schemas are present on every request in the owning preset. Tool results add data-dependent JSON only after a call; search compacts each result content to 320 Unicode code points and applies the configured result count.

#### KV Cache effect

The schema prefix is stable while plugin configuration and tool visibility remain unchanged. Calls and results append after that prefix; changing the mounted Consumer or restrictions changes the tool-schema request segment.

## Known Limitations and Deferred Work

- **Exact evidence excerpts** — verified activation deliberately requires a verbatim excerpt; paraphrases remain candidates until another trusted Consumer reviews them.
- **No bulk operations** — each write creates one focused memory revision; import, export, and review queues belong to a future user-facing Consumer.
