# Relay Domain Context

English | [中文](CONTEXT.zh.md)

> This document is the authoritative entry for the product definition, system boundaries, and domain terminology.

## Product definition

Relay is a **zero-learning-curve, simple general-purpose agent**. Users only need to:

1. describe a need in natural language;
2. add files, folders, or other material when needed;
3. review the result and confirm only high-impact actions.

Relay understands context, completes task structure, calls tools, manages long-running work, verifies results, and organizes delivery. Users do not need to learn prompt engineering, create a project, select a specific model, or understand internal agent modules first.

## Two usage modes

| Mode | User mental model | System behavior |
|---|---|---|
| **chat** | Talk directly | Preserve continuous context to answer, explain, or help form a request |
| **work** | Give Relay something to complete | Create an independent task that executes, verifies, recovers, and delivers artifacts |

Work has **no Project prerequisite**. Each Work owns its goal, conversation, file context, run state, and artifacts; users may add files before or during execution.

## Prompt Enhancement

Before submitting a draft in the input box, a user may explicitly click **Enhance**. The system uses the reasonable current context to generate a clearer, executable draft and returns it to the input box:

- it never starts automatically;
- it never submits automatically;
- the user may continue editing, undo, or submit directly;
- it does not read memory or files unrelated to the current request;
- it does not invent a goal for the user.

See [`agent/prompt-enhancing.md`](agent/prompt-enhancing.md) for the detailed contract.

## System boundaries

### Agent side (this project's focus)

The TypeScript implementation, Relay Harness ([ADR-0005](adr/0005-adopt-ts-harness-runtime.md)), lives in the checkout's [`relay-harness/` runtime root](repository-governance.md#canonical-layout) and owns:

- Chat/Work sessions and the agent loop;
- Prompt Enhancement context assembly;
- Work, file introduction, and artifact management;
- plans, tools, skills, and subagents;
- local state, recovery, permission gates, and result verification;
- the governed long-term memory product capability.

### Relay scheduling side (external project)

The scheduling project owns model tiers, model information, costs, benchmark information, entry-signal generation, and concrete model selection. This project specifies only:

- the capabilities the agent needs from scheduling;
- how Chat, Work, and subagents submit requests;
- the HTTP/JSON + SSE interface;
- how user-visible model-strength tiers and pricing information return.

This project does not specify scheduling scores, weights, model-pool implementation, or operating policy.

## Design principles

1. **Users speak naturally; the system supplies structure.**
2. **The default path is simplest; advanced capability appears progressively.**
3. **Work is a task, not a project container.**
4. **Files are explicit context, not an implicit whole-device scan.**
5. **A successful tool execution is not task completion; delivery follows local verification.**
6. **State is externalized and tasks are recoverable.**
7. **Model routing belongs to scheduling; the agent does not train or optimize routing.**
8. **High-impact actions are confirmable and auditable; prefer reversible actions where possible.**

## Glossary

| Term | Definition |
|---|---|
| chat | Continuous conversation mode that does not enter the full execution-oriented agent loop |
| work | An independent executable, recoverable, deliverable task that requires no Project |
| Prompt Enhancement | User-triggered draft improvement before submission |
| Work Context | The current Work's goal, conversation, file manifest, state, and artifacts |
| File Context | Files and folders explicitly added to the current Chat or Work, with their metadata, summaries, and access boundaries |
| Long-term Memory | Governed user information and preferences retained across sessions |
| agent loop | Understand → plan → act → observe → verify locally → deliver/recover |
| subagent | A constrained execution unit created by the primary agent for an independent subtask |
| Routing Signal | `task_type + emphasis weights + difficulty + confidence + source` |
| Model-strength tier | User-visible capability and price gradient; concrete model names remain scheduling-owned |
| Relay scheduling side | An independent project that selects models from signals, capability, benchmarks, cost, and backend policy |
| Local verification | An agent-loop safeguard that confirms task results without upload, training, or routing participation |

## Current stage

The runtime is the TypeScript Harness under the runtime root defined by [ADR-0005](adr/0005-adopt-ts-harness-runtime.md). Default composition ships the agent loop, recovery, tools, subagents, the Chat/Work/Library product shell, explicit Prompt Enhancement, the local Context Engine, governed Memory, Code Index, MCP/skill directories, and ordinary-user-safe permissions.

Relay-specific capabilities that remain unshipped are the external scheduling client and the user-visible model-strength and pricing contract. This document does not duplicate feature status; the machine-readable [`feature-status.json`](feature-status.json) and its CI evidence verifier are the sole authority.
