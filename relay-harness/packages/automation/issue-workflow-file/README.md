# `@relay-harness/rlh-issue-workflow-file`

English | [中文](README.zh.md)

Markdown/YAML provider. YAML front matter carries tracker routing, polling, concurrency, retry, continuation, and stall policy; the Markdown body is the strict first-turn template. Startup requires one valid document. `orchestration.max_continuation_attempts` (default 5, `0` disables the bound) limits how often a completed-but-still-eligible issue is redispatched. Later invalid or missing revisions are logged and the last valid snapshot remains authoritative.

## Model Experience

### Repository workflow prompt

#### What the model sees

The Markdown body after strict replacement of supported `issue.*` and `attempt` fields.

#### Token effect

Task-sized on the first issue turn; the configured continuation template is bounded and repeated only while eligible.

#### KV Cache effect

One run captures one revision. Editing the file changes future runs without rewriting an active Session prefix.

## Known Limitations and Deferred Work

- **Small template language** — only explicit scalar placeholders are supported; conditionals and loops are intentionally absent.
