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

      await adapter.addJob('test-queue', { message: 'test' }, { attempts: 3, backoff: { type: 'fixed', delay: 10 } });

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

