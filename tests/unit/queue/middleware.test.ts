/**
 * Queue Middleware - Unit Tests
 * Tests for rate limiting, priority, and monitoring middleware
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
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

    test('delays the job over the limit, and runs it, whatever millisecond it arrives in', async () => {
      jest.useFakeTimers();
      try {
        // 2 jobs per 100 ms: a token takes 50 ms to come back. A third job
        // that arrives `gap` ms after the second finds part of one there and
        // waits for the rest; 4 ms later that is 0.08 + 0.92 of a token,
        // which floating point makes 0.9999999999999999.
        for (const gap of [0, 1, 4, 5, 6, 7, 13, 26]) {
          let executionCount = 0;
          const rateLimitedHandler = createRateLimitMiddleware(
            async () => {
              executionCount++;
            },
            { max: 2, duration: 100 }
          );
          await rateLimitedHandler(createMockJob({ id: 1 }));
          await rateLimitedHandler(createMockJob({ id: 2 }));
          await jest.advanceTimersByTimeAsync(gap);

          const outcome = rateLimitedHandler(createMockJob({ id: 3 })).then(
            () => 'ran',
            (error: Error) => error.message
          );
          // Not before its token is back...
          await jest.advanceTimersByTimeAsync(50 - gap - 2);
          expect({ gap, executionCount }).toEqual({ gap, executionCount: 2 });
          // ...and then it runs
          await jest.advanceTimersByTimeAsync(10);
          expect({ gap, outcome: await outcome }).toEqual({ gap, outcome: 'ran' });
          expect(executionCount).toBe(3);
        }
      } finally {
        jest.useRealTimers();
      }
    });

    test('runs every job that waits for the same token, one token at a time', async () => {
      jest.useFakeTimers();
      try {
        const ran: number[] = [];
        const rateLimitedHandler = createRateLimitMiddleware(
          async (job: JobContext) => {
            ran.push(job.data.id);
          },
          { max: 2, duration: 100 }
        );
        await rateLimitedHandler(createMockJob({ id: 1 }));
        await rateLimitedHandler(createMockJob({ id: 2 }));

        // Two more at once: both wait for the token that is back in 50 ms
        const outcomes = Promise.all(
          [3, 4].map(id =>
            rateLimitedHandler(createMockJob({ id })).then(
              () => 'ran',
              (error: Error) => error.message
            )
          )
        );
        await jest.advanceTimersByTimeAsync(55);
        expect(ran).toHaveLength(3);
        await jest.advanceTimersByTimeAsync(55);
        expect(await outcomes).toEqual(['ran', 'ran']);
        expect([...ran].sort()).toEqual([1, 2, 3, 4]);
      } finally {
        jest.useRealTimers();
      }
    });

    test('gives up on a limit that can never let a job through', async () => {
      const rateLimitedHandler = createRateLimitMiddleware(async () => {}, {
        max: 0.5,
        duration: 20,
      });

      await expect(rateLimitedHandler(createMockJob({ id: 1 }))).rejects.toThrow(
        'Rate limit still exceeded after waiting'
      );
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

    test('keeps per-job records for the most recent 1000 jobs, and counts every job', async () => {
      const monitored = createMonitoringMiddleware(async () => 'ok', { collector });
      const jobs = Array.from({ length: 1200 }, (_, n) => ({
        ...createMockJob({ n }),
        id: `job-${n}`,
      }));
      for (const job of jobs) await monitored(job);

      expect(collector.getJobMetrics('job-0')).toBeUndefined();
      expect(collector.getJobMetrics('job-199')).toBeUndefined();
      expect(collector.getJobMetrics('job-200')?.success).toBe(true);
      expect(collector.getJobMetrics('job-1199')?.success).toBe(true);
      expect(collector.getQueueStats('test-queue')?.totalJobs).toBe(1200);

      // The number is configurable, and a job that is still running keeps its
      // record however many jobs start after it
      const small = new QueueMetricsCollector({ maxJobMetrics: 2 });
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      const slow = createMonitoringMiddleware(
        async (job: JobContext) => {
          if (job.id === 'slow') await gate;
        },
        { collector: small }
      );
      const running = slow({ ...createMockJob({}), id: 'slow' });
      for (const id of ['a', 'b', 'c', 'd']) await slow({ ...createMockJob({}), id });

      expect(small.getJobMetrics('slow')).toBeDefined();
      expect(small.getJobMetrics('a')).toBeUndefined();
      expect(small.getJobMetrics('d')).toBeDefined();
      release();
      await running;
      expect(small.getJobMetrics('slow')?.success).toBe(true);
      expect(small.getQueueStats('test-queue')?.totalJobs).toBe(5);
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
      expect(stats?.maxDuration).toBeGreaterThan(stats?.minDuration as number);
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
