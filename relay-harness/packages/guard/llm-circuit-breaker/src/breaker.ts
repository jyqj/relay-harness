/** Sliding-window circuit breaker with bounded half-open probes. */

/** Observable breaker states. */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open'

/** Validated state-machine policy. */
export interface CircuitBreakerPolicy {
  readonly windowMs: number
  readonly minSamples: number
  readonly errorRateThreshold: number
  readonly openMs: number
  readonly halfOpenMaxProbes: number
}

/** Open-state rejection with a bounded retry delay. */
export class CircuitBreakerOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`circuit breaker open; retry after ${(retryAfterMs / 1000).toFixed(1)}s`)
    this.name = 'CircuitBreakerOpenError'
  }
}

interface Sample {
  readonly at: number
  readonly failed: boolean
}

/** One provider-local circuit-breaker state machine. */
export class CircuitBreaker {
  private current: CircuitBreakerState = 'closed'
  private openedAt = 0
  private readonly samples: Sample[] = []
  private readonly probes: number[] = []

  constructor(private readonly policy: CircuitBreakerPolicy) {}

  /** Current authoritative state. */
  get state(): CircuitBreakerState {
    return this.current
  }

  /**
   * Admit one request or throw with its retry delay.
   * @param now - monotonic-enough millisecond sample used for windows and leases.
   */
  check(now: number): void {
    switch (this.current) {
      case 'closed':
        return
      case 'open': {
        const elapsed = Math.max(0, now - this.openedAt)
        if (elapsed < this.policy.openMs) {
          throw new CircuitBreakerOpenError(this.policy.openMs - elapsed)
        }
        this.current = 'half-open'
        this.probes.length = 0
        this.claimProbe(now)
        return
      }
      case 'half-open':
        this.claimProbe(now)
        return
    }
  }

  /**
   * Record one terminal request outcome.
   * @param failed - whether this outcome counts as provider failure.
   * @param now - millisecond sample used for the live window.
   */
  record(failed: boolean, now: number): void {
    switch (this.current) {
      case 'closed':
        this.samples.push({ at: now, failed })
        this.evict(now)
        if (this.samples.length >= this.policy.minSamples
          && this.errorRate(now) >= this.policy.errorRateThreshold) this.trip(now)
        return
      case 'open':
        return
      case 'half-open':
        this.probes.shift()
        if (failed) this.trip(now)
        else this.close()
    }
  }

  /**
   * Live-window failure ratio.
   * @param now - millisecond sample used to evict expired outcomes.
   * @returns failures divided by live samples, or zero when empty.
   */
  errorRate(now = Date.now()): number {
    this.evict(now)
    if (this.samples.length === 0) return 0
    return this.samples.filter(sample => sample.failed).length / this.samples.length
  }

  /** Admit one half-open probe, reclaiming abandoned slots after one open duration. */
  private claimProbe(now: number): void {
    while (true) {
      const oldest = this.probes[0]
      if (oldest === undefined || now - oldest < this.policy.openMs) break
      this.probes.shift()
    }
    if (this.probes.length >= this.policy.halfOpenMaxProbes) {
      throw new CircuitBreakerOpenError(Math.min(50, this.policy.openMs))
    }
    this.probes.push(now)
  }

  private evict(now: number): void {
    while (true) {
      const oldest = this.samples[0]
      if (oldest === undefined || now - oldest.at <= this.policy.windowMs) break
      this.samples.shift()
    }
  }

  private trip(now: number): void {
    this.current = 'open'
    this.openedAt = now
    this.probes.length = 0
  }

  private close(): void {
    this.current = 'closed'
    this.samples.length = 0
    this.probes.length = 0
  }
}
