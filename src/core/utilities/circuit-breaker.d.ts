export declare class CircuitBreaker {
  private options;
  private failures;
  private lastFailTime;
  private state;
  constructor(options: {
    failureThreshold: number;
    resetTimeout: number;
    monitoringPeriod: number;
  });
  execute<T>(fn: () => Promise<T>): Promise<T>;
  private onSuccess;
  private onFailure;
}
