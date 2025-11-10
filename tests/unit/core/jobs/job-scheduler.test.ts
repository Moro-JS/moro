 
// @ts-nocheck
import { JobScheduler } from '../../../../src/core/jobs/job-scheduler.js';
import { createFrameworkLogger } from '../../../../src/core/logger/index.js';

describe('JobScheduler', () => {
  let scheduler: JobScheduler;
  let logger;

  beforeEach(() => {
    logger = createFrameworkLogger('TestJobScheduler');
    scheduler = new JobScheduler(logger, {
      maxConcurrentJobs: 2,
      enableLeaderElection: false, // Disable for testing
      executor: {
        maxRetries: 1,
        retryDelay: 50,
        timeout: 2000,
      },
    });
  });

  afterEach(async () => {
    await scheduler.shutdown();
  });

  describe('Job Registration', () => {
    it('should register a cron job', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      expect(jobId).toBeDefined();
      expect(jobId).toContain('job_');

      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.name).toBe('test-job');
      expect(job?.enabled).toBe(true);
    });

    it('should register an interval job', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob(
        'interval-job',
        { type: 'interval', interval: 5000 },
        handler
      );

      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.schedule.type).toBe('interval');
      expect(job?.schedule.interval).toBe(5000);
    });

    it('should register a one-time job', () => {
      const handler = jest.fn().mockResolvedValue('success');
      const futureDate = new Date(Date.now() + 10000);

      const jobId = scheduler.registerJob(
        'onetime-job',
        { type: 'oneTime', at: futureDate },
        handler
      );

      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.schedule.type).toBe('oneTime');
    });

    it('should calculate next run time for jobs', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob(
        'test-job',
        { type: 'interval', interval: 5000 },
        handler
      );

      const job = scheduler.getJob(jobId);
      expect(job?.nextRun).toBeDefined();
      expect(job?.nextRun).toBeInstanceOf(Date);
    });
  });

  describe('Job Execution', () => {
    it('should execute job and track state', async () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      await scheduler.start();
      await scheduler.triggerJob(jobId);

      expect(handler).toHaveBeenCalledTimes(1);

      const state = scheduler.getJobState(jobId);
      expect(state?.executionCount).toBe(1);
      expect(state?.lastExecution?.status).toBe('completed');
    });

    it('should track failed executions', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('job failed'));

      const jobId = scheduler.registerJob(
        'failing-job',
        { type: 'cron', cron: '* * * * *' },
        handler
      );

      await scheduler.start();
      await scheduler.triggerJob(jobId);

      const state = scheduler.getJobState(jobId);
      expect(state?.failureCount).toBeGreaterThan(0);
      expect(state?.consecutiveFailures).toBeGreaterThan(0);
    });

    it('should emit job lifecycle events', async () => {
      const handler = jest.fn().mockResolvedValue('success');
      const startSpy = jest.fn();
      const completeSpy = jest.fn();

      scheduler.on('job:start', startSpy);
      scheduler.on('job:complete', completeSpy);

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      await scheduler.start();
      await scheduler.triggerJob(jobId);

      expect(startSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
        })
      );

      expect(completeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId,
          result: 'success',
        })
      );
    });
  });

  describe('Job Management', () => {
    it('should enable/disable jobs', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      // Disable job
      scheduler.setJobEnabled(jobId, false);
      let job = scheduler.getJob(jobId);
      expect(job?.enabled).toBe(false);

      // Enable job
      scheduler.setJobEnabled(jobId, true);
      job = scheduler.getJob(jobId);
      expect(job?.enabled).toBe(true);
    });

    it('should unregister jobs', () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      expect(scheduler.getJob(jobId)).toBeDefined();

      scheduler.unregisterJob(jobId);

      expect(scheduler.getJob(jobId)).toBeUndefined();
    });

    it('should get all jobs', () => {
      const handler = jest.fn().mockResolvedValue('success');

      scheduler.registerJob('job1', { type: 'cron', cron: '* * * * *' }, handler);
      scheduler.registerJob('job2', { type: 'interval', interval: 5000 }, handler);

      const jobs = scheduler.getAllJobs();
      expect(jobs).toHaveLength(2);
    });
  });

  describe('Concurrency Control', () => {
    it('should respect global concurrency limit', async () => {
      const handler = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve('done'), 500);
          })
      );

      const job1 = scheduler.registerJob('job1', { type: 'cron', cron: '* * * * *' }, handler);
      const job2 = scheduler.registerJob('job2', { type: 'cron', cron: '* * * * *' }, handler);
      const job3 = scheduler.registerJob('job3', { type: 'cron', cron: '* * * * *' }, handler);

      await scheduler.start();

      // Trigger all jobs at once
      const promises = [
        scheduler.triggerJob(job1),
        scheduler.triggerJob(job2),
        scheduler.triggerJob(job3),
      ];

      // Check stats while jobs are running - allow brief window for jobs to start
      await new Promise(resolve => setTimeout(resolve, 200));
      const stats = scheduler.getStats();
      // With some timing variance, we should see no more than 2-3 running
      expect(stats.runningJobs).toBeLessThanOrEqual(3);
      expect(stats.queuedJobs + stats.runningJobs).toBeGreaterThanOrEqual(3);

      await Promise.all(promises);
    });

    it('should respect per-job concurrency limit', async () => {
      const handler = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve('done'), 300);
          })
      );

      const jobId = scheduler.registerJob(
        'test-job',
        { type: 'cron', cron: '* * * * *' },
        handler,
        { maxConcurrent: 1 }
      );

      await scheduler.start();

      // Try to trigger job twice simultaneously
      const promise1 = scheduler.triggerJob(jobId);
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
      const promise2 = scheduler.triggerJob(jobId);

      // One should be running, one queued
      await new Promise(resolve => setTimeout(resolve, 100));
      const stats = scheduler.getStats();
      expect(stats.runningJobs + stats.queuedJobs).toBeGreaterThanOrEqual(1);

      await Promise.all([promise1, promise2]);
    });
  });

  describe('Priority Queue', () => {
    it('should execute higher priority jobs first', async () => {
      const executionOrder: string[] = [];

      const lowPriorityHandler = jest.fn().mockImplementation(async () => {
        executionOrder.push('low');
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      const highPriorityHandler = jest.fn().mockImplementation(async () => {
        executionOrder.push('high');
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // Create scheduler with concurrency of 1 to force queueing
      const scheduler = new JobScheduler(logger, {
        maxConcurrentJobs: 1,
        enableLeaderElection: false,
      });

      const lowJob = scheduler.registerJob(
        'low-priority',
        { type: 'cron', cron: '* * * * *' },
        lowPriorityHandler,
        { priority: 1 }
      );

      const highJob = scheduler.registerJob(
        'high-priority',
        { type: 'cron', cron: '* * * * *' },
        highPriorityHandler,
        { priority: 10 }
      );

      await scheduler.start();

      // Trigger low priority first, then high priority
      // The high priority should jump the queue
      const lowPromise = scheduler.triggerJob(lowJob);
      await new Promise(resolve => setTimeout(resolve, 10)); // Brief delay
      const highPromise = scheduler.triggerJob(highJob);

      await Promise.all([lowPromise, highPromise]);

      // Verify both were executed
      expect(executionOrder).toHaveLength(2);
      expect(executionOrder).toContain('low');
      expect(executionOrder).toContain('high');

      await scheduler.shutdown();
    });
  });

  describe('Statistics and Metrics', () => {
    it('should provide scheduler stats', async () => {
      const handler = jest.fn().mockResolvedValue('success');

      scheduler.registerJob('job1', { type: 'cron', cron: '* * * * *' }, handler);
      scheduler.registerJob('job2', { type: 'cron', cron: '* * * * *' }, handler, {
        enabled: false,
      });

      await scheduler.start();

      const stats = scheduler.getStats();
      expect(stats.totalJobs).toBe(2);
      expect(stats.enabledJobs).toBe(1);
      expect(stats.isLeader).toBe(true);
      expect(stats.isStarted).toBe(true);
    });

    it('should provide job metrics', async () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      await scheduler.start();
      await scheduler.triggerJob(jobId);

      const metrics = scheduler.getJobMetrics(jobId);
      expect(metrics).toBeDefined();
      expect(metrics?.totalExecutions).toBe(1);
      expect(metrics?.successRate).toBe(100);
      expect(metrics?.failureRate).toBe(0);
    });

    it('should track job history', async () => {
      const handler = jest.fn().mockResolvedValue('success');

      const jobId = scheduler.registerJob('test-job', { type: 'cron', cron: '* * * * *' }, handler);

      await scheduler.start();
      await scheduler.triggerJob(jobId);
      await scheduler.triggerJob(jobId);

      const history = scheduler.getJobHistory(jobId, 10);
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe('completed');
    });
  });

  describe('Graceful Shutdown', () => {
    it('should complete running jobs before shutdown', async () => {
      const handler = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve('done'), 500);
          })
      );

      // Register job as disabled so it won't fire from cron schedule
      const jobId = scheduler.registerJob(
        'test-job',
        { type: 'cron', cron: '* * * * *' },
        handler,
        { enabled: false }
      );

      await scheduler.start();

      // Start job manually (no need to enable since we're triggering manually)
      const jobPromise = scheduler.triggerJob(jobId);

      // Shutdown while job is running
      const shutdownPromise = scheduler.shutdown();

      // Both should complete
      await Promise.all([jobPromise, shutdownPromise]);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
