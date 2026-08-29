# Local Verification and Effect Records

English | [中文](verification-and-effects.zh.md)

## 1. Purpose

Local verification is an agent-loop safeguard that answers whether the result the user requested actually occurred. It is independent from model routing, training, telemetry, and operating analysis.

## 2. Two result levels

- `ExecutionResult`: whether a tool executed successfully.
- `EffectRecord`: whether a local check established the expected result.

```yaml
effect_record:
  step_id: string
  expected_effect: string
  status: verified|failed|unverifiable
  method: test|build|lint|readback|schema|comparison|user_confirmation|none
  evidence_ref: string|null
  note: string|null
```

## 3. Verification rules

- Plan steps state an available acceptance method before execution.
- Read files back after writing, query real state after commands, and validate schemas after generating structured artifacts.
- Prefer relevant tests, builds, and typechecks for coding tasks.
- Prefer structure, count, citation, and input/output reconciliation for documents, spreadsheets, and office artifacts.
- Mark an outcome `unverifiable` and disclose it at delivery when no reliable method exists; never pretend it is complete.

## 4. Terminal-state relationship

- Every required effect verified: `complete`.
- A deliverable exists but some required effect failed or is unverifiable: `partial`.
- The core effect failed and no deliverable exists: `failed`.
- An external condition or user confirmation is missing: `blocked`.

## 5. Data boundary

EffectRecord and Evidence remain in local Work State by default. They are not uploaded to scheduling, do not produce training samples, and do not select later models.
