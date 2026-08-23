# `@relay-harness/rlh-issue-runner-agent`

English | [中文](README.zh.md)

Native RLH Agent runner. It creates one Session at the prepared cwd, installs the captured tracker tools before publication, sends the rendered issue prompt, rechecks tracker eligibility after each turn, and reuses the same Agent/Session for bounded continuation turns. The run result settles after Agent disposal.

## Model Experience

### Issue and continuation prompts

#### What the model sees

The repository workflow's rendered first-turn body, followed by compact `continuationPrompt` guidance only while the issue remains eligible.

#### Token effect

The first prompt is task-sized. Each continuation appends one bounded user message. Captured tracker schemas are present for every turn.

#### KV Cache effect

Continuation turns extend the same Session prefix. Workflow or tracker-tool changes apply only to a future run.

## Known Limitations and Deferred Work

- **Fresh Session after host recovery** — durable orchestration retries reuse the workspace but start a new Agent Session; exact live Agent state is not reconstructed.
