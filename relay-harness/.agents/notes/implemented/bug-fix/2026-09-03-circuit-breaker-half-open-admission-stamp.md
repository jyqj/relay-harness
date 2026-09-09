# Agent Note: Circuit-breaker half-open accounting settles outcomes under their admission stamp

Status: implemented

English | [中文](2026-09-03-circuit-breaker-half-open-admission-stamp.zh.md)

## Problem

`CircuitBreaker.record()` routed every outcome by the breaker's state at settlement time, not by the state the request was admitted under. A request admitted while closed (`check()` passed, no probe slot) can settle after another outcome trips the breaker and half-open begins. When that stale outcome arrived, `record()` unconditionally shifted one half-open probe: a stale closed-state success therefore closed the breaker before any real probe reported, and a stale failure tripped the breaker on a probe slot it never claimed. Both paths let pre-trip traffic decide recovery, which is exactly the traffic whose outcomes motivated the trip. Closed-state samples also evicted by age only, so a provider pinned below the failure threshold over a long window could retain an unbounded sample count.

## Decision

`check()` now returns an admission stamp — `{ state: 'closed' }` or `{ state: 'half-open', probe }` carrying the claimed probe lease timestamp — and `record()` routes every outcome by that stamp. A closed-admitted outcome only enters the live window and can trip only while the breaker is still closed. A half-open-admitted outcome releases exactly the probe slot its stamp names (`indexOf` plus `splice`, not an unconditional `shift`) and alone can close or reopen the breaker; an outcome whose probe lease was reclaimed or reset finds no slot and changes no state. Unstamped outcomes are treated as closed-admitted, preserving the plain-class contract for direct `CircuitBreaker` use. The live window additionally retains at most 1000 outcomes (`MAX_SAMPLES`, a fixed memory bound, not a deployment tunable) and drops the oldest beyond that.

The plugin wires stamps end to end. The `agent/request` waterfall stores each admission per agent and provider; because one agent drives at most one model request at a time, `agent/request-error` and committed `assistant/message` outcomes settle exactly the stamp of the request that preceded them, via a FIFO shift on that per-agent per-provider queue. A shed request never admits, so its `CIRCUIT_OPEN` error finds no stamp and records nothing — previously a shed request recorded a connectivity success sample in the half-open window. An untracked success source falls back to closed-admitted to keep recording success for traffic the registry does not track.

## Consequences

Pre-trip in-flight traffic can no longer decide recovery: half-open closes or reopens only on outcomes from requests that actually claimed a probe, and no outcome frees a slot it never claimed, pinned by unit tests for both stale directions plus the sample cap. The retention cap bounds per-provider memory regardless of window configuration. What this costs: a genuine outcome whose probe lease expired during the request is discarded instead of counted, so an abandoned probe delays recovery by one lease (`openMs`) rather than being judged on arrival — the pre-existing reclaim semantics already owned that delay. The plugin's FIFO correlation trusts the loop's one-in-flight-request-per-agent property; a future loop that issues concurrent requests for one agent would need the correlation key widened beyond agent and provider.

## Alternatives considered

- **Keep settlement-time routing and make the plugin not record stale outcomes** — the breaker cannot distinguish a stale outcome from a probe outcome without knowing the admission state, so the defect survives in the class for every other caller.
- **Correlate admissions by request id** — `agent/request-error` carries `turn`/`step` but the `assistant/message` session event carries only the provider source, so no common identity exists today; per-agent FIFO sequencing uses the ordering the loop already guarantees.
- **Drop the shed-request success sample instead of skipping unstamped records** — half-open shed errors are the same mis-accounting, and only the admission stamp can tell them apart, so the stamp has to exist before the distinction can be enforced anywhere.
