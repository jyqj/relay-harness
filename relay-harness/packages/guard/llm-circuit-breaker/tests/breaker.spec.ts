import { describe, expect, it } from 'vitest'
import { CircuitBreaker, CircuitBreakerOpenError } from '../src/breaker.ts'

const policy = {
  windowMs: 100,
  minSamples: 2,
  errorRateThreshold: 0.5,
  openMs: 50,
  halfOpenMaxProbes: 1,
}

describe('CircuitBreaker', () => {
  it('trips from a live sliding window and reports a decreasing retry delay', () => {
    const breaker = new CircuitBreaker(policy)
    expect(breaker.state).toBe('closed')
    expect(breaker.errorRate(0)).toBe(0)
    breaker.check(0)
    breaker.record(false, 0)
    breaker.record(true, 10)
    expect(breaker.state).toBe('open')
    expect(() => { breaker.check(20) }).toThrow(expect.objectContaining({
      name: 'CircuitBreakerOpenError', retryAfterMs: 40,
    }))
    expect(() => { breaker.check(5) }).toThrow(expect.objectContaining({ retryAfterMs: 50 }))
    breaker.record(false, 20)
    expect(breaker.state).toBe('open')
  })

  it('admits one half-open probe, rejects siblings, and closes on success', () => {
    const breaker = new CircuitBreaker(policy)
    breaker.record(true, 0)
    breaker.record(true, 1)
    const probe = breaker.check(51)
    expect(breaker.state).toBe('half-open')
    expect(() => { breaker.check(52) }).toThrow(expect.objectContaining({ retryAfterMs: 50 }))
    breaker.record(false, 53, probe)
    expect(breaker.state).toBe('closed')
    breaker.check(54)
    expect(breaker.errorRate(54)).toBe(0)
  })

  it('reopens on probe failure and reclaims an abandoned probe lease', () => {
    const breaker = new CircuitBreaker({ ...policy, halfOpenMaxProbes: 2 })
    breaker.record(true, 0)
    breaker.record(true, 1)
    breaker.check(51)
    breaker.check(52)
    expect(() => { breaker.check(53) }).toThrow(CircuitBreakerOpenError)
    const probe = breaker.check(102)
    breaker.record(true, 103, probe)
    expect(breaker.state).toBe('open')
  })

  it('evicts expired closed-window samples before computing the rate', () => {
    const breaker = new CircuitBreaker({ ...policy, minSamples: 3, errorRateThreshold: 1 })
    breaker.record(true, 0)
    breaker.record(true, 10)
    expect(breaker.errorRate(200)).toBe(0)
    breaker.record(false, 200)
    expect(breaker.state).toBe('closed')
  })

  it('does not close half-open on a stale closed-admitted success', () => {
    const breaker = new CircuitBreaker(policy)
    const stale = breaker.check(0)
    breaker.record(true, 0)
    breaker.record(true, 1)
    expect(breaker.state).toBe('open')
    const probe = breaker.check(51)
    expect(breaker.state).toBe('half-open')
    breaker.record(false, 52, stale)
    expect(breaker.state).toBe('half-open')
    breaker.record(false, 53, probe)
    expect(breaker.state).toBe('closed')
  })

  it('does not let a stale closed-admitted failure consume a probe slot', () => {
    const breaker = new CircuitBreaker({ ...policy, halfOpenMaxProbes: 1 })
    const stale = breaker.check(0)
    breaker.record(true, 0)
    breaker.record(true, 1)
    const probe = breaker.check(51)
    breaker.record(true, 52, stale)
    expect(breaker.state).toBe('half-open')
    expect(() => { breaker.check(52) }).toThrow(CircuitBreakerOpenError)
    breaker.record(false, 53, probe)
    expect(breaker.state).toBe('closed')
  })

  it('drops the oldest closed-window samples past the retention cap regardless of age', () => {
    const breaker = new CircuitBreaker({
      windowMs: 1_000_000,
      minSamples: 5000,
      errorRateThreshold: 1,
      openMs: 50,
      halfOpenMaxProbes: 1,
    })
    for (let at = 0; at < 1000; at++) breaker.record(false, at)
    breaker.record(true, 1000)
    expect(breaker.errorRate(1000)).toBe(1 / 1000)
  })
})
