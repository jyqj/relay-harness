# Agent Note: Provider-scheduled failure recovery

Status: implemented

English | [中文](2026-08-21-provider-scheduled-failure-recovery.zh.md)

## Problem

Request-failure recovery had three precision gaps. First, classification logic lived inline in `dsh-llm-retry`: the plugin re-derived "is this wait-recoverable" from raw `LlmFailure` fields, so any future recovery policy (credential pool, provider fallback) would have to duplicate that derivation. Second, a provider-named resume delay longer than `maxDelayMs` (default 10 s) was abandoned in normal mode and clamped to local backoff in always mode — a minute-scale rate-limit reset, the most common scheduled recovery signal, fell exactly into that gap. Third, `QUOTA` was uniformly terminal: a periodic quota reset (the provider names a reset time) could never be waited out, even though it is recoverable by definition, while a balance exhaustion (no named time) is not.

## Decision

`dsh-llm` owns a shared structured classification, `classifyLlmFailure`, that folds a normalized `LlmFailure` into one of four recovery classes: `local-retryable` (transient code, wait locally), `provider-scheduled` (the provider named a resume time — strongest signal, beats the code taxonomy), `context-overflow` (recover by compaction, never by waiting), and `terminal`. Context overflow wins over a named delay; a named delay wins over the code. `dsh-llm-retry` consumes the classification instead of deriving its own.

The retry policy gains two validated fields. `backoff.maxProviderDelayMs` (default 60 s, must be ≥ `maxDelayMs`) is the largest provider-named delay the executor honors in full; beyond it normal mode delegates and always mode falls back to local backoff, preserving the old escape hatches. Normal mode's `scheduledCodes` (default empty) makes additional codes eligible only when the provider names a resume delay — this is how a periodic `QUOTA` reset becomes wait-recoverable while a bare `QUOTA` stays terminal. Both fields join the canonical policy key, so a policy change starts a new retry history.

## Alternatives considered

- **Subclassify provider errors into more codes** (`QUOTA_PERIODIC`, `RATE_LIMIT_EXTENDED`). The distinguishing datum — the named resume time — already rides `LlmFailure.providerRetryAfterMs`; new codes would duplicate it and force every consumer to learn a larger taxonomy.
- **Honor unbounded provider delays.** A provider could pin an agent for hours; the cap keeps the escape hatch, and always mode keeps its cannot-terminate guarantee.
- **Default `scheduledCodes` to `['QUOTA']`.** No production evidence yet that the deployed providers name quota reset times; the field ships opt-in, and enabling it is a one-line provider config change once evidence exists.

## Verification

`dsh-llm` unit tests pin classification precedence (overflow over delay, delay over code, transient set, invalid-delay rejection, terminal classes) and policy resolution/validation for both new fields. `dsh-llm-retry` loop tests prove: a 30 s provider delay is waited verbatim (previously abandoned), an over-cap delay still delegates (normal) or uses local backoff (always), and a scheduled `QUOTA` retries only when the provider names a delay while a bare `QUOTA` stays terminal.

## Consequences

Minute-scale provider resets now recover instead of dying after the first attempt, and the periodic-vs-terminal quota split is expressible without new error codes. The classification has one home, so a future credential pool or provider-fallback policy routes on the same classes instead of re-deriving them. Default policy keys change shape, so retry histories from older logs do not continue — acceptable under the pre-release stance.
