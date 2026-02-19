/* eslint-disable */
/**
 * Queue Integration Tests
 * Tests for queue system integration with Moro framework
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createApp } from '../../src/moro';
import type { Moro } from '../../src/moro';

describe('Queue Integration with Moro', () => {
  let app: Moro;

  beforeEach(async () => {
    app = await createApp({
      logger: { level: 'error' }, // Suppress logs during tests
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Queue Registration', () => {
    test('should register a queue using memory adapter', async () => {
      app.queueInit('test-queue', {
        adapter: 'memory',
        concurrency: 5,
      });

      expect(app.hasQueue('test-queue')).toBe(true);
      expect(app.getQueueNames()).toContain('test-queue');
    });

    test('should register multiple queues', async () => {
      app.queueInit('emails', { adapter: 'memory' });
      app.queueInit('images', { adapter: 'memory' });
      app.queueInit('notifications', { adapter: 'memory' });

      expect(app.getQueueNames()).toHaveLength(3);
      expect(app.hasQueue('emails')).toBe(true);
      expect(app.hasQueue('images')).toBe(true);
      expect(app.hasQueue('notifications')).toBe(true);
    });

    test('should return false for non-existent queue', () => {
      expect(app.hasQueue('non-existent')).toBe(false);
    });

    test('should return empty array when no queues registered', () => {
      expect(app.getQueueNames()).toEqual([]);
    });
  });

  describe('Job Operations', () => {
    beforeEach(async () => {
      app.queueInit('test-queue', { adapter: 'memory' });
    });

    test('should add job to queue', async () => {
      const job = await app.addToQueue('test-queue', {
        message: 'Hello from test',
      });

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.data).toEqual({ message: 'Hello from test' });
    });

    test('should add job with options', async () => {
      const job = await app.addToQueue(
        'test-queue',
        { message: 'Test' },
        {
          priority: 10,
          delay: 5000,
          attempts: 3,
        }
      );

      expect(job.opts.priority).toBe(10);
      expect(job.opts.delay).toBe(5000);
      expect(job.opts.attempts).toBe(3);
    });

    test('should add bulk jobs', async () => {
      const jobs = await app.addBulkToQueue('test-queue', [
        { data: { id: 1 } },
        { data: { id: 2 }, options: { priority: 5 } },
        { data: { id: 3 } },
      ]);

      expect(jobs).toHaveLength(3);
      expect(jobs[1].opts.priority).toBe(5);
    });

    test('should throw error when adding to non-existent queue', async () => {
      await expect(async () => {
        await app.addToQueue('non-existent', { data: 'test' });
      }).rejects.toThrow('not registered');
    });
  });

  describe('Job Processing', () => {
    beforeEach(async () => {
      app.queueInit('test-queue', { adapter: 'memory', concurrency: 3 });
    });

    test('should process jobs with simple handler', async () => {
      const processedJobs: any[] = [];

      await app.processQueue('test-queue', async job => {
        processedJobs.push(job.data);
      });

      await app.addToQueue('test-queue', { id: 1 });
      await app.addToQueue('test-queue', { id: 2 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processedJobs.length).toBeGreaterThanOrEqual(2);
    });

    test('should process jobs with concurrency', async () => {
      const processedJobs: any[] = [];

      await app.processQueue('test-queue', 2, async job => {
        processedJobs.push(job.data);
      });

      await app.addToQueue('test-queue', { id: 1 });
      await app.addToQueue('test-queue', { id: 2 });
      await app.addToQueue('test-queue', { id: 3 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(processedJobs.length).toBeGreaterThanOrEqual(3);
    });

    test('should handle job failures', async () => {
      await app.processQueue('test-queue', async job => {
        if (job.data.shouldFail) {
          throw new Error('Job failed');
        }
        return { success: true };
      });

      await app.addToQueue('test-queue', { shouldFail: true }, { attempts: 1 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      // Job should fail but not crash the system
    });
  });

  describe('Queue Status and Control', () => {
    beforeEach(async () => {
      app.queueInit('test-queue', { adapter: 'memory' });
    });

    test('should get queue status', async () => {
      await app.addToQueue('test-queue', { id: 1 });

      const status = await app.getQueueStatus('test-queue');

      expect(status).toBeDefined();
      expect(status.name).toBe('test-queue');
      expect(status.adapter).toBe('memory');
      expect(status.metrics).toBeDefined();
    });

    test('should get specific job', async () => {
      const addedJob = await app.addToQueue('test-queue', { data: 'test' });
      const retrievedJob = await app.getJob('test-queue', addedJob.id);

      expect(retrievedJob).toBeDefined();
      expect(retrievedJob?.id).toBe(addedJob.id);
    });

    test('should get jobs by status', async () => {
      await app.addToQueue('test-queue', { id: 1 });
      await app.addToQueue('test-queue', { id: 2 });

      const jobs = await app.getJobs('test-queue', 'waiting');

      expect(jobs).toBeDefined();
      expect(Array.isArray(jobs)).toBe(true);
    });

    test('should pause and resume queue', async () => {
      await app.pauseQueue('test-queue');
      await app.resumeQueue('test-queue');
      // Should not throw
    });

    test('should remove job', async () => {
      const job = await app.addToQueue('test-queue', { data: 'test' });
      await app.removeJob('test-queue', job.id);

      const retrievedJob = await app.getJob('test-queue', job.id);
      expect(retrievedJob).toBeNull();
    });

    test('should retry failed job', async () => {
      const job = await app.addToQueue('test-queue', { data: 'test' });
      await app.retryJob('test-queue', job.id);
      // Should not throw
    });

    test('should clean queue', async () => {
      await app.addToQueue('test-queue', { data: 'test' });
      await app.cleanQueue('test-queue', 1000, 'completed');
      // Should not throw
    });
  });

  describe('Event Integration', () => {
    test('should emit events through Moro event bus', async () => {
      const events: any[] = [];

      app.events.on('queue:job:added', event => {
        events.push({ type: 'added', event });
      });

      app.events.on('queue:job:completed', event => {
        events.push({ type: 'completed', event });
      });

      app.queueInit('test-queue', { adapter: 'memory' });

      await app.processQueue('test-queue', async job => {
        return { success: true };
      });

      await app.addToQueue('test-queue', { message: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some(e => e.type === 'added')).toBe(true);
    });
  });

  describe('Graceful Shutdown', () => {
    test('should shutdown queues when app closes', async () => {
      app.queueInit('test-queue', { adapter: 'memory' });
      await app.addToQueue('test-queue', { data: 'test' });

      await app.close();

      // After close, queues should be cleaned up
      expect(app.getQueueNames()).toEqual([]);
    });

    test('should handle close without any queues', async () => {
      await app.close();
      // Should not throw
    });
  });

  describe('Real-world Use Cases', () => {
    test('email queue scenario', async () => {
      app.queueInit('emails', {
        adapter: 'memory',
        concurrency: 5,
        defaultJobOptions: {
          attempts: 3,
          removeOnComplete: true,
        },
      });

      const sentEmails: any[] = [];

      await app.processQueue('emails', async job => {
        // Simulate email sending
        sentEmails.push({
          to: job.data.to,
          subject: job.data.subject,
        });
        return { sent: true, messageId: `msg-${job.id}` };
      });

      await app.addToQueue('emails', {
        to: 'user@example.com',
        subject: 'Welcome!',
        body: 'Welcome to our service',
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0].to).toBe('user@example.com');
    });

    test('image processing queue scenario', async () => {
      app.queueInit('images', {
        adapter: 'memory',
        concurrency: 3,
      });

      const processedImages: any[] = [];

      await app.processQueue('images', async job => {
        // Simulate image processing
        await job.updateProgress(50);
        await new Promise(resolve => setTimeout(resolve, 10));
        await job.updateProgress(100);

        processedImages.push({
          url: job.data.url,
          sizes: job.data.sizes,
        });

        return { processed: true };
      });

      await app.addBulkToQueue('images', [
        { data: { url: 'image1.jpg', sizes: ['sm', 'md', 'lg'] } },
        { data: { url: 'image2.jpg', sizes: ['sm', 'md', 'lg'] } },
        { data: { url: 'image3.jpg', sizes: ['sm', 'md', 'lg'] } },
      ]);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(processedImages.length).toBeGreaterThanOrEqual(3);
    });
  });
});
