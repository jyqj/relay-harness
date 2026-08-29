# ADR-0002: Pre-request Routing Signals and User-visible Strength Tiers

English | [中文](0002-routing-and-strength.zh.md)

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

The agent needs to call the external scheduling project without participating in model training, routing optimization, or model-pool management. Scheduling input must exist before a request and cover Chat requests, Work starts, and subagents.

## Decision

1. For each Chat request and Work start, a small scheduling-side model generates a routing signal.
2. When the primary agent starts a subagent, it must supply a complete routing signal in `SubagentSpec`; scheduling does not classify it again.
3. The signal contains a stable task type, emphasis-weight vector, difficulty, confidence, and source.
4. Scheduling selects a concrete model from benchmarks, model capability, cost, and backend operating policy; this project does not define the algorithm.
5. Model-strength tiers expose capability and price gradients to users; concrete model names remain hidden.
6. The number of tiers, their plan relationship, and whether a separate “reasoning effort” exists are `[Decision pending]`.

## Consequences

- The agent neither receives nor uploads training samples and maintains no routing telemetry or margin data.
- Local verification does not feed scheduling or trigger a model cascade.
- The agent and scheduling integrate only through [`../scheduling/interface.md`](../scheduling/interface.md).
