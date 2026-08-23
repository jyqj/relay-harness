# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

Behavioral guard plugins watch the agent loop for unproductive patterns and enforce per-call budgets. A guard is a self-contained consumer of core services and extension points, not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Advisory reminders for repeated tool calls | listens on tool and agent events |
| [`timeout-policy/`](timeout-policy/README.md) | Arms per-call tool deadlines as deployment policy | registers a `tools/execute` listener |
| [`behavior-correction/`](behavior-correction/README.md) | Corrective steers for empty answers, unexecuted code blocks, and unverified completion claims | listens on `agent/turn-stopping` |
| [`llm-circuit-breaker/`](llm-circuit-breaker/README.md) | Provider-local sliding-window request shedding | guards `agent/request`; records request outcomes |
| [`rollout-budget-controller/`](rollout-budget-controller/README.md) | Shared weighted-token budget across one root Agent tree | accounts `assistant/message`; guards pre-step and tools |
| [`token-budget-controller/`](token-budget-controller/README.md) | Bounded continue nudges on max-tokens cutoffs | listens on `agent/turn-stopping` |

Reminders travel as `additionalContexts` on the `tools/post-execute` decision and are appended as logged plugin-sourced `user/message` events ([tools](../../docs/subsystems/tools.md)); the timeout split across `rlh-timeout`, capability termination, and this policy layer is recorded in the [timeout-library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md).
