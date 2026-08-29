# @relay-harness/rlh-mcp-catalog

English | [中文](README.zh.md)

Client-safe descriptor/read/prompt vocabulary is exported from `./types`; the root re-exports it for existing Host consumers.

Protocol-native registry for MCP Resources, Resource Templates, and Prompts. Connected `mcp-client` generations publish fully paginated catalogs atomically. Resource reads preserve bounded text and canonical-base64 blob content; Prompt invocation preserves bounded text, image, audio, resource-link, embedded-resource blocks, and annotations. URI/name/duplicate validation runs before publication. Failed list refreshes leave the last-good descriptors mounted, while disconnected-generation reads fail before touching the stale Client and connection health remains owned by `mcp-client`.

The service registers `mcp-resources` on the shared Context Engine. It hydrates only resource URIs explicitly present in direct user text, contains individual read failures, reports budget/read omissions in coverage, and emits revision-bound Evidence; it never converts resources into tools. `ctx.mcpCatalog.listPrompts()` and `getPrompt()` are the explicit Prompt catalog/invocation seam.

## Model Experience

### Explicit MCP Resource recall

#### What the model sees

A bounded untrusted recall message (`source.plugin = 'mcp-resources'`) only when the user explicitly mentions a catalogued URI.

#### Token effect

Resource reads are rejected above `maxReadBytes`; inline resource JSON is additionally bounded by `maxResources` and `maxChars`. No URI mention adds tokens.

#### KV Cache effect

Resource revisions affect only requests that explicitly include them.

## Known Limitations and Deferred Work

- Resource templates are catalogued but template expansion remains caller-owned.
- Remote servers are unsigned external authorities; catalog health proves connectivity, not content trust.
