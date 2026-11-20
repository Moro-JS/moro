/**
 * Bull queue adapter: the Redis connection it opens carries every setting of
 * the adapter's connection config, including the ACL user and the TLS options,
 * and every job tells BullMQ how many finished jobs to keep.
 *
 * bullmq and ioredis are optional peers and are not installed, so the adapter
 * loads small stand-ins that record the options they are constructed with.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'path';
import { BullAdapter } from '../../../src/core/queue/adapters/bull-adapter.js';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const PACKAGES: Record<string, string> = {
  bullmq: path.join(FIXTURES, 'bullmq-fake/index.cjs'),
  ioredis: path.join(FIXTURES, 'database-drivers-fake/ioredis.cjs'),
};

/** The options of every ioredis client created since the last reset. */
const redisOptions = (): any[] => (globalThis as any).__moroFakeDatabaseDrivers.redis;

describe('BullAdapter connection', () => {
  let adapter: BullAdapter | undefined;

  beforeEach(() => {
    (globalThis as any).__moroFakeDatabaseDrivers = undefined;
    jest.spyOn(packageUtils, 'isPackageAvailable').mockImplementation(name => name in PACKAGES);
    jest.spyOn(packageUtils, 'resolveUserPackage').mockImplementation(name => PACKAGES[name]);
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    jest.restoreAllMocks();
  });

  test('passes username and tls from the connection config to the Redis connection', async () => {
    const tls = { ca: 'PEM', servername: 'redis.internal' };
    adapter = new BullAdapter({
      host: 'redis.internal',
      port: 6380,
      username: 'worker',
      password: 'secret',
      database: 2,
      tls,
    });
    await adapter.initialize();

    expect(redisOptions()).toEqual([
      {
        host: 'redis.internal',
        port: 6380,
        username: 'worker',
        password: 'secret',
        db: 2,
        tls,
        maxRetriesPerRequest: null,
      },
    ]);
  });

  test('opens the connection exactly as before when neither is configured', async () => {
    adapter = new BullAdapter({ host: 'localhost', password: 'secret' });
    await adapter.initialize();

    const [options] = redisOptions();
    expect(options).toEqual({
      host: 'localhost',
      port: 6379,
      password: 'secret',
      db: 0,
      maxRetriesPerRequest: null,
    });
    expect('username' in options || 'tls' in options).toBe(false);
  });

  test('queues and workers share that connection', async () => {
    adapter = new BullAdapter({ username: 'worker', tls: {} });
    await adapter.initialize();
    await adapter.addJob('work', { n: 1 });
    await adapter.process('work', 1, async () => 'ok');

    const connection = (adapter as any).connection;
    expect(connection.options.username).toBe('worker');
    expect((adapter as any).queues.get('work').options.connection).toBe(connection);
    expect((adapter as any).workers.get('work').options.connection).toBe(connection);
  });
});

describe('BullAdapter retention of finished jobs', () => {
  let adapter: BullAdapter | undefined;

  beforeEach(() => {
    (globalThis as any).__moroFakeDatabaseDrivers = undefined;
    jest.spyOn(packageUtils, 'isPackageAvailable').mockImplementation(name => name in PACKAGES);
    jest.spyOn(packageUtils, 'resolveUserPackage').mockImplementation(name => PACKAGES[name]);
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    jest.restoreAllMocks();
  });

  /** removeOnComplete / removeOnFail as BullMQ received them for a job. */
  const kept = (job: { opts: Record<string, unknown> }) => [
    job.opts.removeOnComplete,
    job.opts.removeOnFail,
  ];

  test('asks BullMQ to keep the last 1000 completed and 5000 failed jobs by default', async () => {
    adapter = new BullAdapter({});
    await adapter.initialize();

    expect(kept(await adapter.addJob('work', { n: 1 }))).toEqual([1000, 5000]);
    expect(kept(await adapter.addJob('work', { n: 2 }, { attempts: 3 }))).toEqual([1000, 5000]);

    const bulk = await adapter.addBulkJobs('work', [
      { data: { n: 3 } },
      { data: { n: 4 }, options: { priority: 2 } },
    ]);
    expect(bulk.map(kept)).toEqual([
      [1000, 5000],
      [1000, 5000],
    ]);
  });

  test('passes on the configured numbers', async () => {
    adapter = new BullAdapter({}, { completed: 50, failed: 0 });
    await adapter.initialize();
    // BullMQ: a number is how many to keep, true removes the job at once
    expect(kept(await adapter.addJob('work', {}))).toEqual([50, true]);

    await adapter.close();
    adapter = new BullAdapter({}, { completed: Infinity, failed: Infinity });
    await adapter.initialize();
    // false keeps every job, as BullMQ does when nothing is said
    expect(kept(await adapter.addJob('work', {}))).toEqual([false, false]);
  });

  test("passes on a job's own setting unchanged", async () => {
    adapter = new BullAdapter({});
    await adapter.initialize();

    expect(
      kept(await adapter.addJob('work', {}, { removeOnComplete: true, removeOnFail: false }))
    ).toEqual([true, false]);
    expect(kept(await adapter.addJob('work', {}, { removeOnComplete: 10 }))).toEqual([10, 5000]);

    const [bulk] = await adapter.addBulkJobs('work', [
      { data: {}, options: { removeOnComplete: false, removeOnFail: 7 } },
    ]);
    expect(kept(bulk as any)).toEqual([false, 7]);
  });
});
