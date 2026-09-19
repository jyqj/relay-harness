# @relay-harness/rlh-tool-context

English | [中文](README.zh.md)

Model-facing `retrieve_context` consumer of the existing Context Engine. It registers through `ctx.tools` in its Cordis scope; the shared base mounts it for headless composition, while Web disables that global row and the standard Agent preset mounts its scoped copy. Minimal presets remain unchanged. No new task database, context engine, or remote authentication system is introduced.

## Invocation and authority

Omit `query` to list explicitly tool-enabled source ids without invoking providers. A query optionally selects those ids with `sources`. Caller Session, working directory and preset come from the exact live Agent, never model arguments. Unknown configured source ids fail loudly; an unknown requested source is rejected. Scope and identity are checked before retrieval and after asynchronous completion, and cancellation crosses every read.

Code recall is workspace-bound and refuses a different execution filesystem instead of treating a remote cwd as a Host directory. File reads require explicit `@path` mentions and use the Agent's filesystem with canonical workspace containment. Memory retains its provider-owned preset, subagent and governance policy. Session history searches a bounded current-Session view, not all conversations. MCP hydrates only explicitly named, already catalogued resource URIs; it does not create servers or invoke prompts implicitly.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `maxQueryChars` | `8192` | Query Unicode code points. |
| `maxContextChars` | `12000` | Complete context messages before final tool rendering. |
| `maxContextTokens` | `3000` | Estimated tokens for context selection. |
| `maxOutputChars` | `24000` | Complete result including JSON escaping, provenance and framing. |
| `maxOutputTokens` | `6000` | Estimated tokens for the complete result. |
| `contributors` | omitted | Deployment allowlist; omission retains explicitly tool-enabled sources. |

All numeric values are positive safe integers. Output budgets must contain the context budgets and accommodate the minimal report. The complete rendering is measured, and whole observations or diagnostic rows are omitted with counters when necessary; evidence text is not clipped independently of its digest.

## Model Experience

### Explicit evidence retrieval

#### What the model sees

One `retrieve_context` result containing source descriptors, observations, evidence, coverage, selection decisions and omission counters. `catalog`, `ok`, `partial`, `empty` and `unavailable` describe that operation, not the truth of a negative claim. Source descriptors indicate registration and supported purposes, not provider health or permission grants. Non-text MCP content is not silently rendered as text: the output reports omitted observations.

#### Token effect

Each explicit call pays for the bounded ordinary tool result. This consumer does not call an auxiliary model. Providers may perform configured retrieval or embedding work under their own limits.

#### KV Cache effect

The ordinary tool result is appended once to the Session log and reaches the next model request. It is never duplicated as synthetic user input or a second context injection. Installing the tool changes the advertised tool catalog for the next request snapshot.

## Known Limitations and Deferred Work

Token counts use the existing meter or its documented estimate, not an exact tokenizer. This is bounded retrieval, not exhaustive absence certification. Current-Session history does not activate cold Agents or search unrelated sessions. The tool does not promote recalled content into instructions, execute MCP prompts, approve memory, certify work, or persist a second evidence database. Whole-message providers remain valid alongside candidate-batch providers; ranking is deterministic, not a learned global relevance model.
