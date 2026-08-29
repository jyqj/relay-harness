# @relay-harness/rlh-llm-circuit-breaker

English | [中文](README.zh.md)

An opt-in provider-local sliding-window circuit breaker for Agent model requests. It is not a tool and adds no prompt text. Failures and successful `assistant/message` outcomes feed one breaker per provider route; an open breaker rejects at `agent/request` before transport work with `LlmError('CIRCUIT_OPEN')` and a bounded `providerRetryAfterMs`.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `windowMs` | `60000` | Live outcome window. |
| `minSamples` | `5` | Samples required before tripping. |
| `errorRateThreshold` | `0.5` | Failure ratio from zero through one. |
| `openMs` | `60000` | Open cool-down and abandoned half-open probe lease. |
| `halfOpenMaxProbes` | `1` | Concurrent recovery probes. |
| `failureCodes` | `EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT` | Failures counted as breaker failures. Other failed responses count as successful connectivity samples. |

The timing and threshold defaults follow the imported client-side prior-art preset. The RLH failure-code set replaces its HTTP-only `401` preset because RLH adapters already normalize transport and provider failures into these provider-neutral codes. The package is not loaded by the base bundle; deployments opt in deliberately.

## State machine

Closed requests pass. Each terminal request outcome enters the live window; after `minSamples`, a failure ratio at or above the threshold opens the provider. Open requests are shed without transport work and report the remaining cool-down. After `openMs`, one caller atomically enters half-open and claims a probe. Probe success closes and clears history; probe failure reopens. Additional probes receive a 50 ms bounded backoff. A probe that never reports an outcome is reclaimed after one `openMs` lease, so cancellation cannot strand half-open forever.

Breakers are keyed by the resolved `LlmCallConfig.provider`, after later `agent/request` listeners return their route. `agent/request-error` records configured codes as failure and other codes as connectivity success, while committed assistant messages record success from their durable provider source. Provider routes never share windows.

## Model Experience

### Open-circuit failure

#### What the model sees

Nothing from the breaker itself: the request does not reach a model. Hosts observe a normal Agent error with code `CIRCUIT_OPEN`, message `provider "<provider>" circuit breaker is open`, and a retry delay.

#### Token effect

Zero model tokens for shed requests; successful and failing probe calls spend normally.

#### KV Cache effect

No request is sent while open, so no cache entry changes.

## Known Limitations and Deferred Work

- State is process-local and resets on plugin reload; it is not a distributed provider-health service.
- Requests already in flight when another outcome trips the breaker continue and report normally.
- A non-configured failure code counts as successful connectivity, which keeps authentication or caller-invalid failures from opening a transport/provider availability circuit.
