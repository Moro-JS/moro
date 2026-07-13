// Circuit Breaker Pattern Implementation
import { EventEmitter } from 'events';

export class CircuitBreaker extends EventEmitter {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  // Failure timestamps for the sliding monitoring window (only used when
  // options.monitoringPeriod is set).
  private failureTimestamps: number[] = [];

  constructor(
    private options: {
      failureThreshold: number;
      resetTimeout: number;
      monitoringPeriod?: number;
    }
  ) {
    super();
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailTime < this.options.resetTimeout) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
      this.emit('halfOpen');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    const wasOpen = this.state === 'OPEN' || this.state === 'HALF_OPEN';
    this.failures = 0;
    this.failureTimestamps = [];
    this.state = 'CLOSED';

    if (wasOpen) {
      this.emit('closed');
    }
  }

  private onFailure() {
    const now = Date.now();
    this.lastFailTime = now;

    const period = this.options.monitoringPeriod;
    if (period && period > 0) {
      // Sliding window: only failures within the last `monitoringPeriod` ms
      // count toward the threshold, so isolated failures spread over time don't
      // eventually trip the breaker.
      this.failureTimestamps.push(now);
      const cutoff = now - period;
      while (this.failureTimestamps.length > 0) {
        const oldest = this.failureTimestamps[0];
        if (oldest === undefined || oldest >= cutoff) break;
        this.failureTimestamps.shift();
      }
      this.failures = this.failureTimestamps.length;
    } else {
      this.failures++;
    }

    if (this.failures >= this.options.failureThreshold && this.state !== 'OPEN') {
      this.state = 'OPEN';
      this.emit('open');
    }
  }

  public isOpen(): boolean {
    return this.state === 'OPEN';
  }

  public getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    return this.state;
  }

  public getFailures(): number {
    return this.failures;
  }

  public reset(): void {
    this.failures = 0;
    this.failureTimestamps = [];
    this.state = 'CLOSED';
    this.emit('reset');
  }

  // Methods used in tests for backward compatibility
  public recordSuccess(): void {
    this.onSuccess();
  }

  public recordFailure(): void {
    this.onFailure();
  }
}
