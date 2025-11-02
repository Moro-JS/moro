// Circuit Breaker Pattern Implementation
import { EventEmitter } from 'events';

export class CircuitBreaker extends EventEmitter {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

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
    this.state = 'CLOSED';

    if (wasOpen) {
      this.emit('closed');
    }
  }

  private onFailure() {
    this.failures++;
    this.lastFailTime = Date.now();

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
