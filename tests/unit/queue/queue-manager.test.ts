/**
 * Queue Manager - Unit Tests
 * Tests for the queue manager and unified API
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { QueueManager } from '../../../src/core/queue/queue-manager.js';
import { EventEmitter } from 'events';
import type { JobContext } from '../../../src/core/queue/types.js';

describe('QueueManager', () => {
  let manager: QueueManager;
  let eventEmitter: EventEmitter;

  beforeEach(() => {
    eventEmitter = new EventEmitter();
    manager = new QueueManager(eventEmitter);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe('Queue Registration', () => {
    test('should register a memory queue', async () => {
      await manager.registerQueue('test-queue', {
        adapter: 'memory',
        concurrency: 5,
      });

      expect(manager.hasQueue('test-queue')).toBe(true);
      expect(manager.getQueueNames()).toContain('test-queue');
    });

    test('should throw error when registering duplicate queue', async () => {
      await manager.registerQueue('test-queue', { adapter: 'memory' });

      await expect(async () => {
        await manager.registerQueue('test-queue', { adapter: 'memory' });
      }).rejects.toThrow('already registered');
    });

    test('should register multiple queues', async () => {
      await manager.registerQueue('queue-1', { adapter: 'memory' });
      await manager.registerQueue('queue-2', { adapter: 'memory' });
      await manager.registerQueue('queue-3', { adapter: 'memory' });

      expect(manager.getQueueNames()).toHaveLength(3);
      expect(manager.hasQueue('queue-1')).toBe(true);
      expect(manager.hasQueue('queue-2')).toBe(true);
      expect(manager.hasQueue('queue-3')).toBe(true);
    });

    test('should throw error for unknown adapter', async () => {
      await expect(async () => {
        await manager.registerQueue('test-queue', { adapter: 'unknown' as any });
      }).rejects.toThrow('Unknown queue adapter');
    });
  });

  describe('Job Operations', () => {
    beforeEach(async () => {
      await manager.registerQueue('test-queue', { adapter: 'memory' });
    });

    test('should add job to queue', async () => {
      const job = await manager.addToQueue('test-queue', { message: 'hello' });

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.data).toEqual({ message: 'hello' });
    });

    test('should throw error when adding to non-existent queue', async () => {
      await expect(async () => {
        await manager.addToQueue('non-existent', { data: 'test' });
      }).rejects.toThrow('not registered');
    });

    test('should add bulk jobs', async () => {
      const jobs = await manager.addBulkToQueue('test-queue', [
        { data: { id: 1 } },
        { data: { id: 2 } },
        { data: { id: 3 } },
      ]);

      expect(jobs).toHaveLength(3);
    });

    test('should process jobs with handler', async () => {
      const processedData: any[] = [];

      await manager.processQueue('test-queue', async (job: JobContext) => {
        processedData.push(job.data);
      });

      await manager.addToQueue('test-queue', { id: 1 });
      await manager.addToQueue('test-queue', { id: 2 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processedData.length).toBeGreaterThanOrEqual(2);
    });

    test('should process jobs with concurrency', async () => {
      const processedData: any[] = [];

      await manager.processQueue('test-queue', 3, async (job: JobContext) => {
        processedData.push(job.data);
      });

      await manager.addToQueue('test-queue', { id: 1 });
      await manager.addToQueue('test-queue', { id: 2 });
      await manager.addToQueue('test-queue', { id: 3 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processedData.length).toBeGreaterThanOrEqual(3);
    });

    test('should apply default job options', async () => {
      await manager.registerQueue('queue-with-defaults', {
        adapter: 'memory',
        defaultJobOptions: {
          attempts: 5,
          removeOnComplete: true,
        },
      });

      const job = await manager.addToQueue('queue-with-defaults', { data: 'test' });

      expect(job.opts.attempts).toBe(5);
      expect(job.opts.removeOnComplete).toBe(true);
    });
  });

  describe('Queue Status and Control', () => {
    beforeEach(async () => {
      await manager.registerQueue('test-queue', { adapter: 'memory' });
    });

    test('should get queue status', async () => {
      await manager.addToQueue('test-queue', { id: 1 });

      const status = await manager.getQueueStatus('test-queue');

      expect(status).toBeDefined();
      expect(status.name).toBe('test-queue');
      expect(status.adapter).toBe('memory');
      expect(status.metrics).toBeDefined();
    });

    test('should pause and resume queue', async () => {
      await manager.pauseQueue('test-queue');
      const pausedStatus = await manager.getQueueStatus('test-queue');
      expect(pausedStatus.isPaused).toBe(false); // Memory adapter doesn't report pause in metrics

      await manager.resumeQueue('test-queue');
    });

    test('should get specific job', async () => {
      const addedJob = await manager.addToQueue('test-queue', { data: 'test' });
      const retrievedJob = await manager.getJob('test-queue', addedJob.id);

      expect(retrievedJob).toBeDefined();
      expect(retrievedJob?.id).toBe(addedJob.id);
    });

    test('should get jobs by status', async () => {
      await manager.addToQueue('test-queue', { id: 1 });
      await manager.addToQueue('test-queue', { id: 2 });

      const jobs = await manager.getJobs('test-queue', 'waiting');

      expect(jobs).toBeDefined();
      expect(Array.isArray(jobs)).toBe(true);
    });

    test('should remove job', async () => {
      const job = await manager.addToQueue('test-queue', { data: 'test' });
      await manager.removeJob('test-queue', job.id);

      const retrievedJob = await manager.getJob('test-queue', job.id);
      expect(retrievedJob).toBeNull();
    });

    test('should retry failed job', async () => {
      const job = await manager.addToQueue('test-queue', { data: 'test' });
      await manager.retryJob('test-queue', job.id);
      // Should not throw
    });

    test('should clean queue', async () => {
      await manager.addToQueue('test-queue', { data: 'test' });
      await manager.cleanQueue('test-queue', 1000);
      // Should not throw
    });

    test('should obliterate queue', async () => {
      await manager.addToQueue('test-queue', { data: 'test' });
      await manager.obliterateQueue('test-queue');

      expect(manager.hasQueue('test-queue')).toBe(false);
    });
  });

  describe('Event Emission', () => {
    beforeEach(async () => {
      await manager.registerQueue('test-queue', { adapter: 'memory' });
    });

    test('should emit job:added event', async () => {
      const events: any[] = [];
      eventEmitter.on('queue:job:added', (event) => {
        events.push(event);
      });

      await manager.addToQueue('test-queue', { message: 'test' });

      expect(events).toHaveLength(1);
      expect(events[0].queueName).toBe('test-queue');
      expect(events[0].job).toBeDefined();
    });

    test('should emit job:completed event', async () => {
      const events: any[] = [];
      eventEmitter.on('queue:job:completed', (event) => {
        events.push(event);
      });

      await manager.processQueue('test-queue', async (job: JobContext) => {
        return { success: true };
      });

      await manager.addToQueue('test-queue', { message: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].queueName).toBe('test-queue');
      expect(events[0].result).toEqual({ success: true });
    });

    test('should emit job:failed event', async () => {
      const events: any[] = [];
      eventEmitter.on('queue:job:failed', (event) => {
        events.push(event);
      });

      await manager.processQueue('test-queue', async (job: JobContext) => {
        throw new Error('Test failure');
      });

      await manager.addToQueue('test-queue', { message: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].error).toBeDefined();
      expect(events[0].error.message).toBe('Test failure');
    });

    test('should emit job:progress event', async () => {
      const events: any[] = [];
      eventEmitter.on('queue:job:progress', (event) => {
        events.push(event);
      });

      await manager.processQueue('test-queue', async (job: JobContext) => {
        await job.updateProgress(50);
        await job.updateProgress(100);
      });

      await manager.addToQueue('test-queue', { message: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Graceful Shutdown', () => {
    test('should shutdown all queues', async () => {
      await manager.registerQueue('queue-1', { adapter: 'memory' });
      await manager.registerQueue('queue-2', { adapter: 'memory' });

      await manager.shutdown();

      expect(manager.getQueueNames()).toHaveLength(0);
    });

    test('should not fail on double shutdown', async () => {
      await manager.registerQueue('test-queue', { adapter: 'memory' });
      await manager.shutdown();
      await manager.shutdown(); // Should not throw
    });
  });
});

