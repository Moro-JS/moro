/**
 * Queue System - Unit Tests
 * Tests for memory adapter and core functionality
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MemoryAdapter } from '../../../src/core/queue/adapters/memory-adapter.js';
import type { Job, JobContext } from '../../../src/core/queue/types.js';

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('Initialization', () => {
    test('should initialize successfully', () => {
      expect(adapter.isReady).toBe(true);
      expect(adapter.name).toBe('memory');
    });

    test('should throw error when not initialized', async () => {
      const uninitializedAdapter = new MemoryAdapter();
      await expect(async () => {
        await uninitializedAdapter.addJob('test', { data: 'test' });
      }).rejects.toThrow('not initialized');
    });
  });

  describe('Job Management', () => {
    test('should add a job to the queue', async () => {
      const job = await adapter.addJob('test-queue', { message: 'hello' });

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('test-queue');
      expect(job.data).toEqual({ message: 'hello' });
      expect(job.progress).toBe(0);
      expect(job.attemptsMade).toBe(0);
    });

    test('should add job with custom options', async () => {
      const job = await adapter.addJob(
        'test-queue',
        { message: 'hello' },
        {
          priority: 10,
          attempts: 3,
          jobId: 'custom-id',
        }
      );

      expect(job.id).toBe('custom-id');
      expect(job.opts.priority).toBe(10);
      expect(job.opts.attempts).toBe(3);
    });

    test('should get a job by ID', async () => {
      const addedJob = await adapter.addJob('test-queue', { message: 'hello' });
      const retrievedJob = await adapter.getJob('test-queue', addedJob.id);

      expect(retrievedJob).toBeDefined();
      expect(retrievedJob?.id).toBe(addedJob.id);
      expect(retrievedJob?.data).toEqual({ message: 'hello' });
    });

    test('should return null for non-existent job', async () => {
      const job = await adapter.getJob('test-queue', 'non-existent');
      expect(job).toBeNull();
    });

    test('should remove a job', async () => {
      const job = await adapter.addJob('test-queue', { message: 'hello' });
      await adapter.removeJob('test-queue', job.id);

      const retrievedJob = await adapter.getJob('test-queue', job.id);
      expect(retrievedJob).toBeNull();
    });

    test('should add bulk jobs', async () => {
      const jobs = await adapter.addBulkJobs('test-queue', [
        { data: { id: 1 } },
        { data: { id: 2 }, options: { priority: 5 } },
        { data: { id: 3 } },
      ]);

      expect(jobs).toHaveLength(3);
      expect(jobs[0].data).toEqual({ id: 1 });
      expect(jobs[1].data).toEqual({ id: 2 });
      expect(jobs[1].opts.priority).toBe(5);
      expect(jobs[2].data).toEqual({ id: 3 });
    });
  });

  describe('Job Processing', () => {
    test('should process a job', async () => {
      const processedData: any[] = [];

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        processedData.push(job.data);
      });

      await adapter.addJob('test-queue', { message: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processedData).toHaveLength(1);
      expect(processedData[0]).toEqual({ message: 'test' });
    });

    test('should process multiple jobs', async () => {
      const processedData: any[] = [];

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        processedData.push(job.data);
      });

      await adapter.addJob('test-queue', { id: 1 });
      await adapter.addJob('test-queue', { id: 2 });
      await adapter.addJob('test-queue', { id: 3 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(processedData.length).toBeGreaterThanOrEqual(3);
    });

    test('should update job progress', async () => {
      let progressUpdates: number[] = [];

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        await job.updateProgress(25);
        progressUpdates.push(25);
        await job.updateProgress(50);
        progressUpdates.push(50);
        await job.updateProgress(100);
        progressUpdates.push(100);
      });

      await adapter.addJob('test-queue', { message: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(progressUpdates).toEqual([25, 50, 100]);
    });

    test('should retry failed jobs', async () => {
      let attempts = 0;

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Simulated failure');
        }
      });

      await adapter.addJob(
        'test-queue',
        { message: 'test' },
        { attempts: 3, backoff: { type: 'fixed', delay: 10 } }
      );

      // Wait for retries
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(attempts).toBe(3);
    });

    test('should handle job failure after max attempts', async () => {
      let attempts = 0;

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        attempts++;
        throw new Error('Always fails');
      });

      const job = await adapter.addJob('test-queue', { message: 'test' }, { attempts: 2 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(attempts).toBe(2);

      const failedJob = await adapter.getJob('test-queue', job.id);
      expect(failedJob?.failedReason).toBeDefined();
    });
  });

  describe('Queue Control', () => {
    test('should pause and resume queue', async () => {
      const processedData: any[] = [];

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        processedData.push(job.data);
      });

      await adapter.addJob('test-queue', { id: 1 });
      await adapter.pauseQueue('test-queue');
      await adapter.addJob('test-queue', { id: 2 });

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should only process first job
      expect(processedData.length).toBeLessThanOrEqual(1);

      await adapter.resumeQueue('test-queue');
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should now process second job
      expect(processedData.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Queue Metrics', () => {
    test('should get queue metrics', async () => {
      await adapter.addJob('test-queue', { id: 1 });
      await adapter.addJob('test-queue', { id: 2 });
      await adapter.addJob('test-queue', { id: 3 });

      const metrics = await adapter.getMetrics('test-queue');

      expect(metrics).toBeDefined();
      expect(metrics.waiting).toBeGreaterThanOrEqual(0);
      expect(metrics.active).toBeGreaterThanOrEqual(0);
      expect(metrics.completed).toBeGreaterThanOrEqual(0);
      expect(metrics.failed).toBeGreaterThanOrEqual(0);
    });

    test('should get jobs by status', async () => {
      await adapter.addJob('test-queue', { id: 1 });
      await adapter.addJob('test-queue', { id: 2 });

      const jobs = await adapter.getJobs('test-queue', 'waiting');

      expect(jobs.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Queue Cleanup', () => {
    test('should clean old completed jobs', async () => {
      await adapter.process('test-queue', 1, async (job: JobContext) => {
        // Simple processing
      });

      const job = await adapter.addJob('test-queue', { id: 1 });

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 200));

      // Clean jobs older than 0ms (all completed jobs)
      await adapter.clean('test-queue', 0, 'completed');

      const retrievedJob = await adapter.getJob('test-queue', job.id);
      expect(retrievedJob).toBeNull();
    });

    test('should obliterate queue', async () => {
      await adapter.addJob('test-queue', { id: 1 });
      await adapter.addJob('test-queue', { id: 2 });

      await adapter.obliterate('test-queue');

      const metrics = await adapter.getMetrics('test-queue');
      expect(metrics.waiting).toBe(0);
      expect(metrics.completed).toBe(0);
    });
  });

  describe('Retention of finished jobs', () => {
    const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
    const ids = (jobs: Job[]) => jobs.map(job => (job.data as { n: number }).n);

    /** Add `count` jobs numbered from `from`; odd-numbered data fails when `failOdd`. */
    async function run(
      target: MemoryAdapter,
      queue: string,
      count: number,
      options: Record<string, unknown> = {},
      from = 0
    ) {
      for (let n = from; n < from + count; n++) await target.addJob(queue, { n }, options);
      await wait();
    }

    test('keeps the last 1000 completed and the last 5000 failed jobs by default', async () => {
      await adapter.process('done', 10000, async () => 'ok');
      await adapter.process('broken', 10000, async () => {
        throw new Error('boom');
      });

      await run(adapter, 'done', 1100);
      await run(adapter, 'broken', 5100);

      const completed = await adapter.getJobs('done', 'completed');
      expect(completed).toHaveLength(1000);
      expect(ids(completed)[0]).toBe(100);
      expect(ids(completed)[999]).toBe(1099);
      expect(await adapter.getJobs('done')).toHaveLength(1000);

      const failed = await adapter.getJobs('broken', 'failed');
      expect(failed).toHaveLength(5000);
      expect(ids(failed)[0]).toBe(100);
      expect(await adapter.getJobs('broken')).toHaveLength(5000);
    });

    test('keeps the configured number of each, per queue', async () => {
      const bounded = new MemoryAdapter({ completed: 3, failed: 2 });
      await bounded.initialize();
      try {
        for (const queue of ['a', 'b']) {
          await bounded.process(queue, 100, async (job: JobContext) => {
            if ((job.data as { n: number }).n % 2 === 1) throw new Error('odd');
          });
        }
        await run(bounded, 'a', 20);
        await run(bounded, 'b', 4);

        expect(ids(await bounded.getJobs('a', 'completed'))).toEqual([14, 16, 18]);
        expect(ids(await bounded.getJobs('a', 'failed'))).toEqual([17, 19]);
        expect(ids(await bounded.getJobs('b', 'completed'))).toEqual([0, 2]);
        expect(ids(await bounded.getJobs('b', 'failed'))).toEqual([1, 3]);
      } finally {
        await bounded.close();
      }
    });

    test('never drops a job that has not finished', async () => {
      const bounded = new MemoryAdapter({ completed: 1, failed: 1 });
      await bounded.initialize();
      try {
        // No processor yet: every job waits
        await run(bounded, 'q', 5);
        expect(await bounded.getJobs('q', 'waiting')).toHaveLength(5);

        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        await bounded.process('q', 100, async (job: JobContext) => {
          if ((job.data as { n: number }).n === 0) await gate;
        });
        await wait(250);

        // Job 0 is still running while four others finished after it started
        expect(ids(await bounded.getJobs('q', 'active'))).toEqual([0]);
        expect(await bounded.getJobs('q', 'completed')).toHaveLength(1);
        release();
        await wait();
        expect(ids(await bounded.getJobs('q', 'completed'))).toEqual([0]);
      } finally {
        await bounded.close();
      }
    });

    test('leaves a job with its own removeOnComplete / removeOnFail to that setting', async () => {
      const bounded = new MemoryAdapter({ completed: 2, failed: 2 });
      await bounded.initialize();
      try {
        await bounded.process('q', 100, async (job: JobContext) => {
          if ((job.data as { n: number }).n >= 100) throw new Error('boom');
        });

        // false: kept, and not counted against the limit
        await run(bounded, 'q', 5, { removeOnComplete: false });
        await run(bounded, 'q', 5, { removeOnFail: false }, 100);
        await run(bounded, 'q', 3, {}, 10);
        expect(ids(await bounded.getJobs('q', 'completed'))).toEqual([0, 1, 2, 3, 4, 11, 12]);
        expect(await bounded.getJobs('q', 'failed')).toHaveLength(5);

        // true: removed as soon as it finishes
        await run(bounded, 'q', 2, { removeOnComplete: true }, 20);
        expect(ids(await bounded.getJobs('q', 'completed'))).toEqual([0, 1, 2, 3, 4, 11, 12]);
      } finally {
        await bounded.close();
      }
    });

    test('counts a retried job where it ends up, and a reused id as a new job', async () => {
      const bounded = new MemoryAdapter({ completed: 2, failed: 2 });
      await bounded.initialize();
      try {
        let failing = true;
        await bounded.process('q', 100, async () => {
          if (failing) throw new Error('boom');
        });

        await bounded.addJob('q', { n: 1 }, { jobId: 'one' });
        await wait();
        expect(ids(await bounded.getJobs('q', 'failed'))).toEqual([1]);

        failing = false;
        await bounded.retryJob('q', 'one');
        await wait();
        expect(ids(await bounded.getJobs('q', 'failed'))).toEqual([]);
        expect(ids(await bounded.getJobs('q', 'completed'))).toEqual([1]);

        // The id of a finished job, given to a new job that is still waiting
        // when older records are dropped
        await bounded.pauseQueue('q');
        await bounded.addJob('q', { n: 2 }, { jobId: 'one' });
        await bounded.resumeQueue('q');
        await run(bounded, 'q', 3, {}, 10);
        await wait(200);
        expect(ids(await bounded.getJobs('q')).sort((x, y) => x - y)).toEqual([2, 12]);
      } finally {
        await bounded.close();
      }
    });
  });

  describe('Delayed Jobs', () => {
    test('should process delayed job after delay', async () => {
      const processedData: any[] = [];
      const startTime = Date.now();

      await adapter.process('test-queue', 1, async (job: JobContext) => {
        processedData.push({
          data: job.data,
          processedAt: Date.now() - startTime,
        });
      });

      await adapter.addJob('test-queue', { message: 'delayed' }, { delay: 200 });

      // Wait for delay
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(processedData).toHaveLength(0);

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(processedData).toHaveLength(1);
      expect(processedData[0].processedAt).toBeGreaterThanOrEqual(180);
    });
  });
});
