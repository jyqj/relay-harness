/** Browser synchronization state; no business data or transport generation escapes this source. */
export interface ConnectionReadinessSnapshot {
  /** Ready means the connected sink settled successfully, not that every optional provider succeeded. */
  readonly phase: 'stopped' | 'connecting' | 'synchronizing' | 'ready' | 'reconnecting' | 'error'
  /** Monotone handshake identity used to invalidate requests across Host restarts. */
  readonly epoch: number
}

/** Read-only observable synchronization state for Client consumers. */
export interface ConnectionReadinessSource {
  /** @returns the same snapshot until phase or handshake identity changes. */
  getSnapshot(): ConnectionReadinessSnapshot
  /** @param listener - change observer. @returns subscription disposer. */
  subscribe(listener: () => void): () => void
}

/** Owns one plugin instance's synchronization publication independently from Host capabilities. */
export class ConnectionReadiness implements ConnectionReadinessSource {
  private snapshot: ConnectionReadinessSnapshot = { phase: 'stopped', epoch: 0 }
  private readonly listeners = new Set<() => void>()

  getSnapshot(): ConnectionReadinessSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish one lifecycle transition, advancing identity only for a new handshake.
   * @param phase - current owner state.
   * @param handshake - whether this is a new Host handshake.
   */
  publish(phase: ConnectionReadinessSnapshot['phase'], handshake = false): void {
    if (!handshake && this.snapshot.phase === phase) return
    this.snapshot = { phase, epoch: this.snapshot.epoch + (handshake ? 1 : 0) }
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) {
        console.error('[web-runtime] connection-readiness listener threw:', error)
      }
    }
  }
}
