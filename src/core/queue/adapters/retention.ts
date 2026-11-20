/**
 * Bounded retention of job records an adapter keeps in memory.
 *
 * Every adapter that mirrors jobs in a Map keeps, per queue, the most recent
 * completed jobs, the most recent failed jobs and (for the broker adapters,
 * where the broker holds the job itself) the most recent records of jobs that
 * have not finished here. Older records are dropped from the Map.
 *
 * A job that carries its own removeOnComplete / removeOnFail setting is left
 * to that setting.
 */

import type { QueueRetentionOptions } from '../types.js';

/** Finished and unfinished job records kept per queue unless configured. */
export const DEFAULT_QUEUE_RETENTION = {
  completed: 1000,
  failed: 5000,
  unfinished: 10000,
} as const;

interface RetainedJob {
  finishedOn?: number | undefined;
}

type JobStore = Map<string, RetainedJob>;

interface QueueRecords {
  completed: Set<string>;
  failed: Set<string>;
  unfinished: Set<string>;
}

function limitOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return fallback;
  return value === Infinity ? Infinity : Math.floor(value);
}

export class JobRetention {
  readonly completed: number;
  readonly failed: number;
  readonly unfinished: number;
  // Job ids per queue, oldest first (a Set iterates in insertion order)
  private queues = new Map<string, QueueRecords>();

  constructor(options: QueueRetentionOptions = {}) {
    this.completed = limitOf(options?.completed, DEFAULT_QUEUE_RETENTION.completed);
    this.failed = limitOf(options?.failed, DEFAULT_QUEUE_RETENTION.failed);
    this.unfinished = limitOf(options?.unfinished, DEFAULT_QUEUE_RETENTION.unfinished);
  }

  /**
   * A record of a job that has not finished was stored. Only for adapters
   * whose broker holds the job: dropping the record loses nothing but what
   * getJob() can report in this process before the job is delivered.
   */
  track(queueName: string, jobId: string, store: JobStore): void {
    const records = this.records(queueName);
    records.completed.delete(jobId);
    records.failed.delete(jobId);
    records.unfinished.delete(jobId);
    records.unfinished.add(jobId);
    while (records.unfinished.size > this.unfinished) {
      const oldest = records.unfinished.values().next().value as string;
      records.unfinished.delete(oldest);
      store.delete(oldest);
    }
  }

  /**
   * A job finished for good. `ownSetting` is the job's removeOnComplete /
   * removeOnFail: when the job says itself what happens to its record, that
   * decides, and the record is not counted here.
   */
  finished(
    queueName: string,
    jobId: string,
    outcome: 'completed' | 'failed',
    ownSetting: unknown,
    store: JobStore
  ): void {
    const records = this.records(queueName);
    records.unfinished.delete(jobId);
    records.completed.delete(jobId);
    records.failed.delete(jobId);
    if (ownSetting !== undefined && ownSetting !== null) return;

    const kept = records[outcome];
    const limit = outcome === 'completed' ? this.completed : this.failed;
    kept.add(jobId);
    while (kept.size > limit) {
      const oldest = kept.values().next().value as string;
      kept.delete(oldest);
      // The id may have been given to a newer job that is still running
      if (store.get(oldest)?.finishedOn !== undefined) store.delete(oldest);
    }
  }

  /** The record was removed, or the job is about to run again. */
  forget(queueName: string, jobId: string): void {
    const records = this.queues.get(queueName);
    if (!records) return;
    records.completed.delete(jobId);
    records.failed.delete(jobId);
    records.unfinished.delete(jobId);
  }

  /** Forget one queue, or every queue. */
  clear(queueName?: string): void {
    if (queueName === undefined) this.queues.clear();
    else this.queues.delete(queueName);
  }

  private records(queueName: string): QueueRecords {
    let records = this.queues.get(queueName);
    if (!records) {
      records = { completed: new Set(), failed: new Set(), unfinished: new Set() };
      this.queues.set(queueName, records);
    }
    return records;
  }
}
