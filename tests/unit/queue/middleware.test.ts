/* eslint-disable */
/**
 * Queue Middleware - Unit Tests
 * Tests for rate limiting, priority, and monitoring middleware
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  createRateLimitMiddleware,
  RateLimiter,
  createPriorityMiddleware,
  Priority,
  PriorityQueue,
  createMonitoringMiddleware,
  QueueMetricsCollector,
} from '../../../src/core/queue/middleware/index.js';
import type { JobContext } from '../../../src/core/queue/types.js';

describe('Queue Middleware', () => {
  describe('Rate Limiting', () => {
    test('should allow jobs within rate limit', async () => {
      let executionCount = 0;
      const handler = async (job: JobContext) => {
        executionCount++;
      };

      const rateLimitedHandler = createRateLimitMiddleware(handler, {
        max: 5,
        duration: 1000,
      });

      // Execute 3 jobs (within limit)
      for (let i = 0; i < 3; i++) {
        await rateLimitedHandler(createMockJob({ id: i }));
      }

      expect(executionCount).toBe(3);
    });

    test('should delay jobs when rate limit exceeded', async () => {
      let executionCount = 0;
      const handler = async (job: JobContext) => {
        executionCount++;
      };

      const rateLimitedHandler = createRateLimitMiddleware(handler, {
        max: 2,
        duration: 100,
      });

      const startTime = Date.now();

      // Execute 3 jobs (1 over limit)
      for (let i = 0; i < 3; i++) {
        await rateLimitedHandler(createMockJob({ id: i }));
      }

      const duration = Date.now() - startTime;

      expect(executionCount).toBe(3);
      expect(duration).toBeGreaterThan(30); // Should have some delay
    });

    test('should use RateLimiter factory methods', () => {
      const perSecond = RateLimiter.perSecond(10);
      expect(perSecond.max).toBe(10);
      expect(perSecond.duration).toBe(1000);

      const perMinute = RateLimiter.perMinute(100);
      expect(perMinute.max).toBe(100);
      expect(perMinute.duration).toBe(60000);

      const perHour = RateLimiter.perHour(1000);
      expect(perHour.max).toBe(1000);
      expect(perHour.duration).toBe(3600000);
    });
  });

  describe('Priority Handling', () => {
    test('should process jobs with priority middleware', async () => {
      let processedPriority: number | undefined;
      const handler = async (job: JobContext) => {
        processedPriority = job.opts.priority;
      };

      const priorityHandler = createPriorityMiddleware(handler, {
        defaultPriority: Priority.NORMAL,
      });

      await priorityHandler(createMockJob({ id: 1 }, { priority: Priority.HIGH }));

      expect(processedPriority).toBe(Priority.HIGH);
    });

    test('PriorityQueue should order by priority', () => {
      const queue = new PriorityQueue<string>();

      queue.enqueue('low', Priority.LOW);
      queue.enqueue('critical', Priority.CRITICAL);
      queue.enqueue('high', Priority.HIGH);
      queue.enqueue('normal', Priority.NORMAL);

      expect(queue.dequeue()).toBe('critical');
      expect(queue.dequeue()).toBe('high');
      expect(queue.dequeue()).toBe('normal');
      expect(queue.dequeue()).toBe('low');
    });

    test('PriorityQueue should handle size operations', () => {
      const queue = new PriorityQueue<number>();

      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);

      queue.enqueue(1, Priority.NORMAL);
      queue.enqueue(2, Priority.HIGH);

      expect(queue.isEmpty()).toBe(false);
      expect(queue.size()).toBe(2);

      queue.clear();
      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);
    });

    test('PriorityQueue should peek without removing', () => {
      const queue = new PriorityQueue<string>();

      queue.enqueue('first', Priority.HIGH);
      queue.enqueue('second', Priority.LOW);

      expect(queue.peek()).toBe('first');
      expect(queue.size()).toBe(2); // Still 2 items
    });

    test('PriorityQueue should convert to array', () => {
      const queue = new PriorityQueue<number>();

      queue.enqueue(3, Priority.LOW);
      queue.enqueue(1, Priority.CRITICAL);
      queue.enqueue(2, Priority.HIGH);

      const array = queue.toArray();
      expect(array).toEqual([1, 2, 3]);
    });
  });

  describe('Monitoring Middleware', () => {
    let collector: QueueMetricsCollector;

    beforeEach(() => {
      collector = new QueueMetricsCollector();
    });

    test('should collect job metrics', async () => {
      const handler = async (job: JobContext) => {
        return { success: true };
      };

      const monitoredHandler = createMonitoringMiddleware(handler, {
        collector,
      });

      const job = createMockJob({ id: 1 });
      await monitoredHandler(job);

      const metrics = collector.getJobMetrics(job.id);
      expect(metrics).toBeDefined();
      expect(metrics?.success).toBe(true);
      expect(metrics?.duration).toBeGreaterThanOrEqual(0);
    });

    test('should track failed jobs', async () => {
      const handler = async (job: JobContext) => {
        throw new Error('Test error');
      };

      const monitoredHandler = createMonitoringMiddleware(handler, {
        collector,
      });

      const job = createMockJob({ id: 1 });

      await expect(async () => {
        await monitoredHandler(job);
      }).rejects.toThrow('Test error');

      const metrics = collector.getJobMetrics(job.id);
      expect(metrics).toBeDefined();
      expect(metrics?.success).toBe(false);
      expect(metrics?.error).toBe('Test error');
    });

    test('should collect aggregated queue stats', async () => {
      const handler = async (job: JobContext) => {
        if (job.data.shouldFail) {
          throw new Error('Failed');
        }
        return { success: true };
      };

      const monitoredHandler = createMonitoringMiddleware(handler, {
        collector,
      });

      // Process successful jobs
      await monitoredHandler(createMockJob({ id: 1, shouldFail: false }));
      await monitoredHandler(createMockJob({ id: 2, shouldFail: false }));

      // Process failed job
      try {
        await monitoredHandler(createMockJob({ id: 3, shouldFail: true }));
      } catch {
        // Expected
      }

      const stats = collector.getQueueStats('test-queue');
      expect(stats).toBeDefined();
      expect(stats?.totalJobs).toBe(3);
      expect(stats?.successfulJobs).toBe(2);
      expect(stats?.failedJobs).toBe(1);
      expect(stats?.averageDuration).toBeGreaterThanOrEqual(0);
    });

    test('should cleanup old metrics', () => {
      // Record many metrics
      for (let i = 0; i < 1500; i++) {
        collector.recordStart(`job-${i}`, 'test-queue', 0);
        collector.recordCompletion(`job-${i}`, true);
      }

      collector.cleanup(1000);

      // Should only keep last 1000
      expect(collector.getJobMetrics('job-0')).toBeUndefined();
      expect(collector.getJobMetrics('job-1499')).toBeDefined();
    });

    test('should track min/max duration', async () => {
      const handler = async (job: JobContext) => {
        await new Promise(resolve => setTimeout(resolve, job.data.delay || 0));
        return { success: true };
      };

      const monitoredHandler = createMonitoringMiddleware(handler, {
        collector,
      });

      await monitoredHandler(createMockJob({ delay: 10 }));
      await monitoredHandler(createMockJob({ delay: 50 }));
      await monitoredHandler(createMockJob({ delay: 20 }));

      const stats = collector.getQueueStats('test-queue');
      expect(stats).toBeDefined();
      expect(stats?.minDuration).toBeGreaterThan(0);
      expect(stats?.maxDuration).toBeGreaterThan(stats?.minDuration);
    });
  });
});

/**
 * Helper to create a mock job context
 */
function createMockJob(data: any, options: any = {}): JobContext {
  return {
    id: `job-${Math.random()}`,
    name: 'test-queue',
    data,
    progress: 0,
    attemptsMade: 0,
    timestamp: Date.now(),
    opts: options,
    updateProgress: async (progress: number) => {
      // Mock implementation
    },
    log: (message: string) => {
      // Mock implementation
    },
  };
}
