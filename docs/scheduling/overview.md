# Relay Scheduling Requirements and Boundaries

English | [中文](overview.zh.md)

## 1. Position

Relay scheduling is an external project used by the Relay agent. It receives model-call content, constraints, and routing signals, selects a concrete model, and returns results through one streaming protocol.

## 2. Qualitative requirements

Scheduling maintains and considers:

- task type, emphasis weights, and difficulty signals;
- model performance across benchmarks;
- model capability and user-visible strength tiers;
- actual model cost;
- availability, context, tool-call, and other capability constraints;
- active backend operating policy, including preferred traffic for partner models.

The scheduling project owns candidate filtering, normalization, weights, formulas, and operating limits; this project does not specify them.

## 3. Signal sources

| Call site | Signal source | Scheduling requirement |
|---|---|---|
| Each Chat request | Scheduling-side small model | Generate a signal, then select a model |
| Each Work start | Scheduling-side small model | Generate a signal, then select the primary model |
| Subagent | Primary agent | Validate the supplied signal and select directly without reclassification |

See [`../agent/routing-signals.md`](../agent/routing-signals.md) for signal structure.

## 4. Strength and pricing

- Concrete models map to user-visible strength tiers.
- Strength tiers map to price gradients.
- Scheduling returns the actual strength tier and pricing version at call start and reconcilable usage at completion.
- Tier count, plan relationship, and independent reasoning effort remain undecided, so the interface uses stable IDs rather than premature enums.

## 5. Agent boundary

The agent does not participate in:

- model or routing training;
- benchmark maintenance;
- model-pool, cost, or operating-weight management;
- routing-quality telemetry or margin reporting;
- automatic model cascades after verification failure.

Scheduling does not own Work state, tool execution, file permissions, local verification, or long-term memory.
