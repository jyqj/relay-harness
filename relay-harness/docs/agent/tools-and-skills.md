# Tools and Skills

English | [中文](tools-and-skills.zh.md)

## 1. Tool layer

Tools are the only execution channel through which the agent reads or changes the external world. Initial categories:

| Category | Capability |
|---|---|
| Files | Inventory, read, generate, precise edit, and export |
| Terminal | Controlled execution of builds, tests, scripts, and queries |
| Search | Locate content inside current File Context |
| Network | Search and retrieve public material |
| Delivery | Produce `ArtifactRef` and result summaries |

## 2. Tool contracts

- Parameters use strict schemas.
- Results distinguish success, failure, partial results, and cancellation.
- Large output spills to a local reference and contributes only a summary to context.
- Prefer idempotent writes; non-idempotent operations inspect existing state first.
- Tool errors give the agent actionable information and the UI translates them into ordinary language.
- Tool permission follows current Work file and action boundaries.

## 3. Skills

A skill is a reusable task method, template, and acceptance rule rather than a new permission source.

```yaml
skill_manifest:
  name: string
  description: string
  applicable_task_types: [string]
  instructions_ref: string
  required_tools: [string]
  input_schema: object|null
  output_schema: object|null
  verification: [string]
```

Rules:

- A skill cannot expand File Context or bypass permission gates.
- Prompt Enhancement may use the selected skill's input/output requirements to complete the user's draft.
- A skill without reliable output requirements cannot claim automatic completion of a structured task.
- Skill selection is not model selection; model calls still use the external scheduling interface.
