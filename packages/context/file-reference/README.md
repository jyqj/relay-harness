# `@relay-harness/rlh-file-reference`

English | [中文](README.zh.md)

File-reference discovery seam and browser-safe `@file` grammar shared by host-backed user interfaces. `ctx.fileReferences.list(agent, query, signal)` returns path-only file or directory candidates for the addressed agent; concrete providers own namespace access, ranking, caching, and invalidation. The same contract is remotely callable as the unary `fileReferences/list` Remote method (`@Remote` on the Service Definition, cancelled through the reserved trailing signal), so browser consumers call `ctx.remote.fileReferences.list` without an API Proxy route.

`activeAtToken()` recognizes an `@path` or open `@"path with spaces` token only at the start of input or after whitespace, so email-like text does not open completion. `formatFileMention()` emits the matching prompt spelling, appends `/` to directory candidates, preserves an explicitly opened quote, and rejects control characters or embedded quotes that the editor grammar cannot represent safely. `parseFileMentions()` extracts the completed mentions of prompt text under the same grammar — quoted `@"path"` spellings and unquoted paths that start at input start or after whitespace — deduplicated in first-occurrence order.

Selecting a candidate does not itself read or attach file contents. Providers that inject mentioned files' contents into a step report them through the `file-reference` recall message source (`form: 'recall'`, one record per distinct mention with its resolved path, revision, included bytes, truncation, or unavailable reason), declared here by declaration merging on `MessageSourceMap`. The exported `FILE_REFERENCE_PROMPT` is stable guidance that a provider may install when the addressed agent can call `read`.

## Model Experience

Indirectly, through `@relay-harness/rlh-file-reference-local`, which conditionally contributes this package's stable file-reference guidance and, when its `fileContent` section is enabled, one recall message per step carrying the mentioned files' snapshots.

#### KV Cache effect

The interface, grammar, and recall source record add no request tokens themselves; provider-owned prompt sections and injected recall messages determine cache behavior.

## Known Limitations and Deferred Work

- **Path candidates are advisory** — the seam does not prove that a later model-facing filesystem tool can access the same namespace; deployments must align the provider with the effective `read` implementation.
- **Content injection is provider-owned and opt-in** — the seam defines the recall source record and the mention parser; reading mentioned files into a step requires a provider that enables it (`@relay-harness/rlh-file-reference-local`'s `fileContent` section) against a filesystem service in the same namespace.
