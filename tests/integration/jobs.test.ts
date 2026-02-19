// @ts-nocheck
import { createApp } from '../../src/index.js';

describe('Jobs Integration', () => {
  let app;

  beforeEach(async () => {
    app = await createApp({
      jobs: {
        enabled: true,
        maxConcurrentJobs: 5,
        enableLeaderElection: false,
        gracefulShutdownTimeout: 1000, // Fast shutdown for tests
        executor: {
          memoryThreshold: 2048, // Higher threshold for CI environment (2GB)
        },
      },
      logger: {
        level: 'error', // Reduce logging noise in tests
      },
      workers: {
        enabled: false, // Disable workers for faster tests
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Job Registration API', () => {
    it('should register cron job with string syntax', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = app.job('test-job', '0 * * * *', handler);

      expect(jobId).toBeDefined();
      expect(jobId).toMatch(/^job_/);
    });

    it('should register interval job with string syntax', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = app.job('test-job', '5m', handler);

      expect(jobId).toBeDefined();
    });

    it('should register job with cron macro', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = app.job('test-job', '@daily', handler);

      expect(jobId).toBeDefined();
    });

    it('should register job with options', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = app.job('test-job', '* * * * *', handler, {
        enabled: true,
        priority: 10,
        timeout: 30000,
        maxRetries: 3,
        metadata: { team: 'backend' },
      });

      expect(jobId).toBeDefined();
    });

    it('should throw error if job scheduler not enabled', async () => {
      const app = await createApp({ jobs: { enabled: false }, logger: { level: 'error' } });

      expect(() => {
        app.job('test-job', '* * * * *', () => {});
      }).toThrow('Job scheduler is not enabled');

      await app.close();
    });
  });

  describe('Job Execution', () => {
    it('should execute job on manual trigger', async () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = app.job('test-job', '* * * * *', handler);

      const result = await app.triggerJob(jobId);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('should pass context to job handler', async () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = app.job('test-job', '* * * * *', handler);

      await app.triggerJob(jobId, { custom: 'data' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
          executionId: expect.stringMatching(/^exec_/),
          metadata: expect.objectContaining({ custom: 'data' }),
        })
      );
    });

    it('should call lifecycle hooks', async () => {
      const onStart = jest.fn();
      const onComplete = jest.fn();
      const handler = jest.fn().mockResolvedValue('result');

      const jobId = app.job('test-job', '* * * * *', handler, {
        onStart,
        onComplete,
      });

      await app.triggerJob(jobId);

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.anything(), 'result');
    });

    it('should call onError hook on failure', async () => {
      const onError = jest.fn();
      const handler = jest.fn().mockRejectedValue(new Error('job failed'));

      const jobId = app.job('test-job', '* * * * *', handler, {
        maxRetries: 0,
        onError,
      });

      await app.triggerJob(jobId);

      expect(onError).toHaveBeenCalledWith(expect.anything(), expect.any(Error));
    });
  });

  describe('Job Management', () => {
    it('should enable/disable jobs', () => {
      const handler = jest.fn().mockResolvedValue('success');
      const jobId = app.job('test-job', '* * * * *', handler);

      const result1 = app.setJobEnabled(jobId, false);
      expect(result1).toBe(true);

      const result2 = app.setJobEnabled(jobId, true);
      expect(result2).toBe(true);
    });

    it('should unregister jobs', () => {
      const handler = jest.fn().mockResolvedValue('success');
      const jobId = app.job('test-job', '* * * * *', handler);

      const result = app.unregisterJob(jobId);
      expect(result).toBe(true);

      // Should return false for non-existent job
      const result2 = app.unregisterJob(jobId);
      expect(result2).toBe(false);
    });
  });

  describe('Job Metrics and Health', () => {
    it('should get job metrics', async () => {
      const handler = jest.fn().mockResolvedValue('success');
      const jobId = app.job('test-job', '* * * * *', handler);

      await app.triggerJob(jobId);

      const metrics = app.getJobMetrics(jobId);
      expect(metrics).toBeDefined();
      expect(metrics?.totalExecutions).toBe(1);
      expect(metrics?.successRate).toBe(100);
    });

    it('should get job health', async () => {
      const handler = jest.fn().mockResolvedValue('success');
      const jobId = app.job('test-job', '* * * * *', handler);

      await app.triggerJob(jobId);

      const health = app.getJobHealth(jobId);
      expect(health).toBeDefined();
      expect(health.status).toBe('healthy');
      expect(health.consecutiveFailures).toBe(0);
    });

    it('should get all job health', () => {
      const handler = jest.fn().mockResolvedValue('success');

      app.job('job1', '* * * * *', handler);
      app.job('job2', '* * * * *', handler);

      const healthList = app.getJobHealth();
      expect(Array.isArray(healthList)).toBe(true);
      expect(healthList).toHaveLength(2);
    });

    it('should get scheduler stats', () => {
      const handler = jest.fn().mockResolvedValue('success');

      app.job('job1', '* * * * *', handler);
      app.job('job2', '* * * * *', handler, { enabled: false });

      const stats = app.getJobStats();
      expect(stats).toBeDefined();
      expect(stats?.totalJobs).toBe(2);
      expect(stats?.enabledJobs).toBe(1);
    });

    it('should get scheduler health', () => {
      const handler = jest.fn().mockResolvedValue('success');
      app.job('job1', '* * * * *', handler);

      const health = app.getSchedulerHealth();
      expect(health).toBeDefined();
      expect(health.status).toBeDefined();
      expect(health.jobs).toHaveLength(1);
    });
  });

  describe('Job Scheduler Lifecycle', () => {
    it('should start job scheduler on listen', done => {
      const handler = jest.fn().mockResolvedValue('success');
      app.job('test-job', '* * * * *', handler);

      const port = 3100 + Math.floor(Math.random() * 1000);

      app.listen(port, () => {
        const stats = app.getJobStats();
        expect(stats?.isStarted).toBe(true);

        app.close().then(done);
      });
    }, 5000); // Reduced timeout from 10000

    it('should shutdown job scheduler on close', async () => {
      const handler = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            const timer = setTimeout(() => resolve('done'), 100); // Reduced from 500ms
            timer.unref(); // Don't keep process alive
          })
      );

      const jobId = app.job('test-job', '* * * * *', handler);

      const port = 3100 + Math.floor(Math.random() * 1000);

      await new Promise<void>(resolve => {
        app.listen(port, () => resolve());
      });

      // Trigger job
      const jobPromise = app.triggerJob(jobId);

      // Close should wait for job
      await app.close();
      await jobPromise;

      expect(handler).toHaveBeenCalled();
    }, 5000); // Reduced timeout from 10000
  });

  describe('Error Handling', () => {
    it('should handle invalid job ID gracefully', () => {
      const result = app.setJobEnabled('invalid-id', true);
      expect(result).toBe(false);
    });

    it('should handle metrics for non-existent job', () => {
      const metrics = app.getJobMetrics('non-existent');
      expect(metrics).toBeNull();
    });

    it('should handle health check when scheduler not enabled', async () => {
      const app = await createApp({ jobs: { enabled: false }, logger: { level: 'error' } });

      const health = app.getJobHealth('job1');
      expect(health.status).toBe('unknown');
      expect(health.message).toContain('not enabled');

      await app.close();
    });
  });
});
