# Agent Note: Provider-local LLM circuit breaker

Status: implemented

English | [中文](2026-08-21-provider-local-llm-circuit-breaker.zh.md)

## Problem

Request retry can recover an isolated transient failure, but repeated failures from one provider route still let every Agent spend transport latency and retry budget. A process needs a shared provider-health decision that sheds new calls during an observed outage, admits a bounded recovery probe, and never blocks an unrelated provider.

## Decision

`@deepseek-ai/dsh-llm-circuit-breaker` is an opt-in guard plugin. It owns one `CircuitBreaker` per resolved provider route and checks after downstream `agent/request` route selection but before transport dispatch. An open route throws `LlmError` with code `CIRCUIT_OPEN` and the remaining cool-down as `providerRetryAfterMs`.

The state machine uses a live time window, minimum sample count, failure-rate threshold, open duration, and bounded half-open probes. Defaults follow the imported client preset: 60-second window, five samples, 0.5 threshold, 60-second open duration, and one probe. DSH's provider-neutral transient failure codes replace the reference's HTTP-specific client code. Other errors count as successful connectivity samples, so authorization or caller-invalid failures do not claim provider unavailability.

Committed assistant messages record success from their durable provider source. `agent/request-error` records each failed attempt before delegating recovery, so retries contribute their actual outcomes. A half-open probe slot is reclaimed after one open duration if cancellation prevents any outcome; success closes and clears history, while failure reopens. Provider maps are process-local and isolated.

## Alternatives considered

**Add the breaker inside each adapter.** Rejected because adapters would duplicate state machines and Agents using the same registered route would not necessarily share health.

**Fold it into retry policy.** Rejected because retry owns one failed request's recovery; the breaker owns admission of later independent requests. Mixing them makes retry count and circuit samples mutually recursive.

**Use one global circuit.** Rejected because one failed provider would shed healthy routes.

**Trip on every error code.** Rejected because auth, invalid arguments, and quota ownership can be caller-specific and do not prove transport/provider outage.

**Allow unlimited half-open probes.** Rejected because a recovery stampede defeats the open period. One probe is the imported client preset; configuration can raise it.

**Persist breaker state.** Rejected because wall-clock cool-down and in-flight probes are process health, not durable conversation facts. Reload starts from closed.

## Consequences

Repeated configured failures shed later calls before network work and surface a stable retryable delay. A successful probe restores traffic, a failed probe reopens, abandoned probes self-heal, and provider routes remain independent.

Already-running requests can overshoot the trip point. The plugin is deliberately absent from the base bundle until a deployment opts into its provider-health policy.

Pure state-machine, real Agent-loop, and Loader-YAML tests cover window eviction, trip/open delays, half-open exclusion, abandoned-probe reclaim, success close, failure reopen, provider isolation, failure-code classification, pre-transport shedding, validation, and invariant registration at per-file 100% coverage.
