# Agent Note: Durable context-preparation trace

Status: implemented

English | [中文](2026-08-29-durable-context-preparation-trace.zh.md)

## Problem

Context contributors returned revision-bound evidence and retrieval coverage, but ContextEngine discarded coverage and AgentLoop consumed only contributed messages. The model-visible messages remained replayable, while the evidence needed for freshness, source inspection, and retrieval feedback vanished before the request. Persisting messages alone could not distinguish which contributor supported which message or whether `agent/pre-step` removed a proposed context message.

## Decision

`prepareStep()` returns each contribution with its contributor id, message, evidence, and optional coverage, plus direct message, evidence, and coverage aggregates. At the ContextEngine boundary each provider-owned result is detached, lossless-JSON validated, and deeply frozen; duplicate or empty evidence ids fail the whole preparation. `Evidence.domain` accepts only lossless `JsonValue`, so no mutable or wire-invalid provider payload can survive until a later AgentLoop append or Prompt Enhancement Remote serialization.

ContextEngine remains independent of Session ownership. AgentLoop carries the preparation through the ordinary `agent/pre-step` decision and, only for an accepted step, appends events in this order: `step/start`, admitted `user/message` events, one log-only `context/prepared` event, then request-header materialization and model dispatch. The trace records contributor attribution, evidence, coverage, and the seqs of exact unmodified message records that survived admission. A removed or rewritten proposal retains an empty seq list, so provenance never claims that altered text was supported by the original evidence. Message content stays exclusively in `user/message`; `context/prepared` is not a second transcript and does not participate in `deriveMessages()`.

The context-engine invariant rejects a trace outside its named open step, a second trace in that step, a trace after request/model/tool activity, repeated contributor or evidence ids, and links to another step, later events, non-message events, duplicate events, or differently identified events. Persistence reload, compaction, and closed-turn forks preserve the links because seq and message ids are immutable log identities; the trace remains log-only while surface rewrites affect only derived model history.

## Alternatives considered

- **Let ContextEngine append its own event** — rejected because only AgentLoop knows whether `agent/pre-step` accepted the step and which exact messages entered the model-visible surface.
- **Store evidence inside each `user/message`** — rejected because message source types would inherit provider-specific provenance, surface replacements would need to preserve retrieval metadata, and every transcript consumer would pay for data it does not render.
- **Persist message ids without event seqs** — rejected because ids identify content across representations but do not identify the exact durable occurrences admitted into one step.
- **Record only admitted contributions** — rejected because removal and rewrite are retrieval outcomes needed by diagnostics and feedback; an explicit empty link list preserves that fact without calling the proposal model-visible.

## Consequences

Every accepted context preparation adds one log-only event and duplicates evidence and coverage once in durable storage, but adds no model tokens. The Client Remote assembly re-exports the event payload, Evidence, and coverage types, so SDK consumers can narrow the generic `SessionEvent<'context/prepared'>` delivered by history APIs. Clients can build source drawers and feedback projections from session facts without querying ephemeral provider state. A non-JSON or duplicate-evidence provider result fails atomically inside `prepareStep()` before AgentLoop opens a step or admits any model-visible context, rather than leaving a partial transcript or producing an unreplayable request.
