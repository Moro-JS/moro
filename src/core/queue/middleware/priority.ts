/**
 * Priority Handling Middleware for Queue Processing
 * Manages job priority and execution order
 */

import type { JobHandler, JobContext } from '../types.js';

/**
 * Priority levels
 */
export enum Priority {
  CRITICAL = 1,
  HIGH = 2,
  NORMAL = 3,
  LOW = 4,
  VERY_LOW = 5,
}

/**
 * Priority middleware options
 */
export interface PriorityOptions {
  defaultPriority?: Priority;
  logPriority?: boolean;
}

/**
 * Create a priority-aware job handler
 */
export function createPriorityMiddleware<T = any, R = any>(
  handler: JobHandler<T, R>,
  options: PriorityOptions = {}
): JobHandler<T, R> {
  return async (job: JobContext<T>): Promise<R> => {
    const priority = job.opts.priority || options.defaultPriority || Priority.NORMAL;

    if (options.logPriority) {
      const priorityName = Priority[priority] || 'UNKNOWN';
      job.log(`Processing job with priority: ${priorityName} (${priority})`);
    }

    return await handler(job);
  };
}

/**
 * Priority queue helper
 * Sorts jobs by priority before processing
 */
export class PriorityQueue<T> {
  private items: Array<{ priority: number; value: T }> = [];

  /**
   * Add an item to the priority queue
   */
  enqueue(value: T, priority: number = Priority.NORMAL): void {
    const item = { priority, value };

    // Find correct position based on priority
    let added = false;
    for (let i = 0; i < this.items.length; i++) {
      if (item.priority < this.items[i].priority) {
        this.items.splice(i, 0, item);
        added = true;
        break;
      }
    }

    if (!added) {
      this.items.push(item);
    }
  }

  /**
   * Remove and return the highest priority item
   */
  dequeue(): T | undefined {
    return this.items.shift()?.value;
  }

  /**
   * Peek at the highest priority item without removing it
   */
  peek(): T | undefined {
    return this.items[0]?.value;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.items.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.items = [];
  }

  /**
   * Get all items sorted by priority
   */
  toArray(): T[] {
    return this.items.map(item => item.value);
  }
}
