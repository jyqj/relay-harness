# Vision and Positioning

English | [中文](vision-and-positioning.zh.md)

## One-sentence position

**Relay is a zero-learning-curve, simple general-purpose agent: users speak naturally and introduce material; Relay understands, executes, verifies, and delivers.**

## Product promise

| Users do not need to | Relay owns |
|---|---|
| Learn prompt engineering | Controlled Prompt Enhancement |
| Create a project and configure a workspace first | Create Work directly and introduce required files explicitly |
| Understand model or provider names | Obtain an appropriate model through external scheduling |
| Watch every technical step | Present progress, blockers, and results in ordinary language |
| Recover from failed commands manually | Retry, change approach, or request minimal help inside safety boundaries |
| Decide whether a tool really took effect | Verify locally through the agent loop |

## Target users

- Ordinary users unfamiliar with prompts and agent workflows;
- people who want to hand off a piece of digital work directly;
- individuals and teams with mixed coding, research, document, spreadsheet, and organization needs.

Developers may use advanced capabilities, but the default product experience cannot require a developer mental model.

## Experience north stars

1. Minimize extra actions between a natural-language draft and execution.
2. Complete tasks without requiring users to understand Projects, models, or routing.
3. Ask only when goal ambiguity or a high-impact action truly blocks progress.
4. Every Work clearly delivers results, artifacts, and unfinished items.

## Where technical advantages belong

Model scheduling, tools, skills, subagents, memory, and recovery implement the product promise; they are not concepts users must learn. Lower cost is one scheduling benefit but never outranks completing the task well and making it easy to use.

## Non-goals

- An expert tool that requires users to write complex prompts.
- A Project prerequisite for Work.
- Concrete model-name selection in the default flow.
- Agent-side model training, routing datasets, or scheduling algorithms.
- Replacing local task state, audits, and verification with telemetry.
