# Agent-side Routing Signals

English | [中文](routing-signals.zh.md)

## 1. Boundary

The agent supplies content, constraints, and agreed routing signals for each call site. Model capability, benchmarks, cost, operating weights, and concrete model selection belong to the external scheduling project.

The agent maintains no training samples, routing telemetry, classifier-accuracy data, or model-cost reports.

## 2. Signal structure

```yaml
routing_signal:
  task_type: string
  emphasis:
    <dimension>: number
  difficulty: trivial|easy|medium|hard|frontier
  confidence: number
  source: pre_classifier|parent_agent
```

Constraints:

- `emphasis` is a sparse weight vector whose values sum to `1.0`;
- the interface contract versions the dimension vocabulary;
- `confidence` is in `0..1`;
- callers cannot arbitrarily forge `source`.

## 3. Signal sources

### Chat requests and Work starts

For each Chat request or Work start, the agent submits content and constraints with `signal_mode=pre_classify`, not a generated signal. Scheduling first calls its small model to generate a signal and then selects a model internally.

### Subagents

The primary agent must provide a complete signal with `signal_mode=provided` and `source=parent_agent` when creating a subagent. Scheduling validates its schema and uses it directly without a second small-model classification.

A missing signal, invalid weights, or incompatible vocabulary version fails the subagent request with an actionable error rather than being guessed silently.

## 4. Relationship to verification

Local verification is not a routing signal. Verification failure is not sent to scheduling, does not trigger automatic model replacement, and does not become training data.

## 5. Interface

See [`../scheduling/interface.md`](../scheduling/interface.md) for transport fields, SSE events, and error semantics.
