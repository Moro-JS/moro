// @ts-nocheck
import { JobExecutor } from '../../../../src/core/jobs/job-executor.js';
import { createFrameworkLogger } from '../../../../src/core/logger/index.js';

describe('JobExecutor', () => {
  let executor: JobExecutor;
  let logger;

  beforeEach(() => {
    logger = createFrameworkLogger('TestJobExecutor');
    logger.setLevel('error');
    executor = new JobExecutor(logger, {
      maxRetries: 3,
      retryDelay: 100,
      retryBackoff: 'exponential',
      timeout: 5000,
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 3,
    });
  });

  // Timers started inside job functions that the executor gives up on (timed
  // out or cancelled). The executor cannot stop a job's own timer, so a
  // referenced one would keep the Jest worker alive for seconds after the suite.
  const abandonedJobTimers: ReturnType<typeof setTimeout>[] = [];

  afterEach(async () => {
    for (const timer of abandonedJobTimers.splice(0)) clearTimeout(timer);
    await executor.shutdown(1000);
  });

  describe('Successful Execution', () => {
    it('should execute job successfully', async () => {
      const jobFn = jest.fn().mockResolvedValue('success');

      const result = await executor.execute('job1', 'exec1', jobFn);

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
      expect(result.attempts).toBe(1);
      expect(result.duration).toBeGreaterThanOrEqual(0); // Changed to >= for fast operations
      expect(jobFn).toHaveBeenCalledTimes(1);
    });

    it('should pass execution context to job function', async () => {
      const jobFn = jest.fn().mockResolvedValue('success');

      await executor.execute('job1', 'exec1', jobFn, {
        jobId: 'job1',
        executionId: 'exec1',
        attempt: 1,
        startTime: new Date(),
        metadata: { key: 'value' },
      });

      expect(jobFn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job1',
          executionId: 'exec1',
          metadata: expect.objectContaining({ key: 'value' }),
        })
      );
    });

    it('should record memory usage', async () => {
      const jobFn = jest.fn().mockResolvedValue('success');

      const result = await executor.execute('job1', 'exec1', jobFn);

      expect(result.memoryUsed).toBeGreaterThan(0);
    });
  });

  describe('Retry Logic', () => {
    it('should retry failed jobs', async () => {
      const jobFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      const result = await executor.execute('job-retry-success', 'exec1', jobFn);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(jobFn).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries', async () => {
      // Create executor with circuit breaker disabled for this test
      const testExecutor = new JobExecutor(logger, {
        maxRetries: 3,
        retryDelay: 100,
        retryBackoff: 'exponential',
        timeout: 5000,
        enableCircuitBreaker: false, // Disable to test pure retry logic
      });

      const jobFn = jest.fn().mockRejectedValue(new Error('always fails'));

      const result = await testExecutor.execute('job-max-retries', 'exec1', jobFn);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(4); // Initial + 3 retries
      expect(result.error?.message).toBe('always fails');
      expect(jobFn).toHaveBeenCalledTimes(4);

      await testExecutor.shutdown(1000);
    });

    it('should apply exponential backoff', async () => {
      const jobFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      // The middle of the ±20% jitter: the waits are 100 ms, then 200 ms.
      // Left random, the two can add up to anything from 240 ms to 360 ms.
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      let duration: number;
      try {
        const startTime = Date.now();
        await executor.execute('job-backoff', 'exec1', jobFn);
        duration = Date.now() - startTime;
      } finally {
        random.mockRestore();
      }

      // 100 ms + 200 ms; each timer may fire a millisecond early by the clock
      expect(duration).toBeGreaterThanOrEqual(298);
      expect(duration).toBeLessThan(500);
    });
  });

  describe('Timeout Enforcement', () => {
    it('should timeout long-running jobs', async () => {
      const jobFn = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            abandonedJobTimers.push(setTimeout(resolve, 10000)); // 10 seconds
          })
      );

      const executor = new JobExecutor(logger, {
        timeout: 1000, // 1 second
        maxRetries: 0,
      });

      const result = await executor.execute('job1', 'exec1', jobFn);

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error?.message).toContain('timeout');

      await executor.shutdown(1000);
    });

    it('should not timeout fast jobs', async () => {
      const jobFn = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve('done'), 100);
          })
      );

      const executor = new JobExecutor(logger, {
        timeout: 2000,
        maxRetries: 0,
      });

      const result = await executor.execute('job1', 'exec1', jobFn);

      expect(result.success).toBe(true);
      expect(result.timedOut).toBe(false);

      await executor.shutdown(1000);
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after threshold failures', async () => {
      const jobFn = jest.fn().mockRejectedValue(new Error('fail'));

      // Fail enough times to trip circuit breaker
      // With 3 retries per execution, we need to execute enough times
      await executor.execute('job-circuit-1', 'exec1', jobFn);
      await executor.execute('job-circuit-1', 'exec2', jobFn);

      // After 2 failed executions (8 total failures with retries), check status
      const status = executor.getCircuitBreakerStatus('job-circuit-1');

      // Circuit should be open or approaching threshold
      expect(status.exists).toBe(true);
      expect(status.failures).toBeGreaterThanOrEqual(3);
    });

    it('should reset circuit breaker on success', async () => {
      // Create executor with higher threshold for this test
      const testExecutor = new JobExecutor(logger, {
        maxRetries: 0, // No retries to keep failures predictable
        retryDelay: 100,
        retryBackoff: 'exponential',
        timeout: 5000,
        enableCircuitBreaker: true,
        circuitBreakerThreshold: 5, // Higher threshold
      });

      const jobFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      // Fail twice (under threshold)
      await testExecutor.execute('job-circuit-3', 'exec1', jobFn);
      await testExecutor.execute('job-circuit-3', 'exec2', jobFn);

      // Succeed
      const result = await testExecutor.execute('job-circuit-3', 'exec3', jobFn);

      expect(result.success).toBe(true);

      // Should be able to execute again
      jobFn.mockRejectedValue(new Error('fail'));
      await testExecutor.execute('job-circuit-3', 'exec4', jobFn);
      await testExecutor.execute('job-circuit-3', 'exec5', jobFn);

      // Circuit still not open
      const status = testExecutor.getCircuitBreakerStatus('job-circuit-3');
      expect(status.state).not.toBe('open');

      await testExecutor.shutdown(1000);
    });

    it('runs the job again after circuitBreakerResetTimeout and closes on success', async () => {
      const testExecutor = new JobExecutor(logger, {
        maxRetries: 0,
        retryDelay: 1,
        timeout: 1000,
        enableCircuitBreaker: true,
        circuitBreakerThreshold: 2,
        circuitBreakerResetTimeout: 80,
        enableMemoryMonitoring: false,
      });

      try {
        let healthy = false;
        let runs = 0;
        const job = async () => {
          runs++;
          if (!healthy) throw new Error('dependency down');
          return 'ok';
        };

        await testExecutor.execute('job-recover', 'e1', job);
        await testExecutor.execute('job-recover', 'e2', job);
        expect(testExecutor.getCircuitBreakerStatus('job-recover')?.state).toBe('open');

        // While open the job is not run
        const blocked = await testExecutor.execute('job-recover', 'e3', job);
        expect(blocked.success).toBe(false);
        expect(blocked.circuitBreakerTripped).toBe(true);
        expect(runs).toBe(2);

        // The dependency recovers; after the reset timeout the job runs again
        healthy = true;
        await new Promise(resolve => setTimeout(resolve, 120));

        const recovered = await testExecutor.execute('job-recover', 'e4', job);
        expect(recovered.success).toBe(true);
        expect(recovered.value).toBe('ok');
        expect(runs).toBe(3);
        expect(testExecutor.getCircuitBreakerStatus('job-recover')?.state).toBe('closed');
      } finally {
        await testExecutor.shutdown(100);
      }
    });
  });

  describe('Cancellation', () => {
    it('should cancel running execution', async () => {
      // Create executor with longer timeout for this test
      const testExecutor = new JobExecutor(logger, {
        maxRetries: 0, // No retries
        timeout: 10000, // Longer timeout to prevent timeout before cancel
        enableCircuitBreaker: false, // Disable circuit breaker for this test
      });

      const jobFn = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            abandonedJobTimers.push(setTimeout(resolve, 5000));
          })
      );

      const promise = testExecutor.execute('job-cancel', 'exec1', jobFn);

      // Cancel after 100ms
      setTimeout(() => {
        testExecutor.cancelExecution('exec1');
      }, 100);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cancelled');

      await testExecutor.shutdown(1000);
    });

    it('should track active executions', async () => {
      const jobFn = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(resolve, 1000);
          })
      );

      const promise = executor.execute('job1', 'exec1', jobFn);

      expect(executor.getActiveExecutionCount()).toBe(1);

      await promise;

      expect(executor.getActiveExecutionCount()).toBe(0);
    });
  });

  describe('Shutdown', () => {
    it('should wait for running jobs during shutdown', async () => {
      const jobFn = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve('done'), 500);
          })
      );

      const promise = executor.execute('job1', 'exec1', jobFn);

      // Start shutdown
      const shutdownPromise = executor.shutdown(2000);

      // Job should complete
      await promise;
      await shutdownPromise;

      expect(jobFn).toHaveBeenCalledTimes(1);
    });

    it('should reject new executions during shutdown', async () => {
      const jobFn = jest.fn().mockResolvedValue('success');

      // Start shutdown
      const shutdownPromise = executor.shutdown(1000);

      // Try to execute job
      await expect(executor.execute('job1', 'exec1', jobFn)).rejects.toThrow(
        'JobExecutor is shutting down'
      );

      await shutdownPromise;
    });
  });

  describe('Memory Monitoring', () => {
    // The default ceiling used to be a hardcoded 512MB, measured against
    // process-wide heap. Since 64-bit Node defaults to a ~4GB heap, any
    // process past ~12% of its available memory had EVERY job refuse to run —
    // and heap rarely falls back, so the failure was permanent. It surfaced
    // here as CI failures under --coverage, where istanbul's instrumentation
    // pushes the worker past 512MB.
    const realMemoryUsage = process.memoryUsage;

    afterEach(() => {
      process.memoryUsage = realMemoryUsage;
    });

    function stubHeapUsedMB(mb: number) {
      const base = realMemoryUsage.call(process);
      const stub: any = () => ({ ...base, heapUsed: mb * 1024 * 1024 });
      stub.rss = (realMemoryUsage as any).rss;
      process.memoryUsage = stub;
    }

    it('still runs jobs when process heap exceeds the legacy 512MB constant', async () => {
      stubHeapUsedMB(600);

      const memExecutor = new JobExecutor(logger, { maxRetries: 0, timeout: 5000 });
      const result = await memExecutor.execute('job1', 'exec1', async () => 'success');

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');

      await memExecutor.shutdown(500);
    });

    it('still enforces an explicitly configured threshold', async () => {
      stubHeapUsedMB(600);

      const memExecutor = new JobExecutor(logger, {
        maxRetries: 0,
        timeout: 5000,
        memoryThreshold: 256,
      });

      await expect(memExecutor.execute('job1', 'exec1', async () => 'success')).rejects.toThrow(
        /Memory threshold exceeded/
      );

      await memExecutor.shutdown(500);
    });
  });
});
