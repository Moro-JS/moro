/**
 * Broker queue adapters (Kafka, RabbitMQ, SQS): a job produced by another
 * process runs the registered handler, retries stop at the configured
 * attempts with the count carried in the message, and a malformed message is
 * skipped without throwing.
 *
 * amqplib, kafkajs and the AWS SDK are optional peers and are not installed,
 * so each adapter runs against a small in-memory fake of the client surface it
 * uses, injected in place of the lazily loaded client.
 */

import { describe, test, expect, afterEach, jest } from '@jest/globals';
import path from 'path';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';
import { KafkaAdapter } from '../../../src/core/queue/adapters/kafka-adapter.js';
import { RabbitMQAdapter } from '../../../src/core/queue/adapters/rabbitmq-adapter.js';
import { SQSAdapter } from '../../../src/core/queue/adapters/sqs-adapter.js';
import { decodeJobMessage } from '../../../src/core/queue/adapters/job-message.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import type { JobContext, QueueRetentionOptions } from '../../../src/core/queue/types.js';

const QUEUE = 'jobs';

const settle = (ms = 60) => new Promise<void>(resolve => setTimeout(resolve, ms));

// warn()/error() are instance properties (noops below the active level), so
// observe the shared private log(level, message) sink instead.
function captureErrors() {
  const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  return () => spy.mock.calls.filter(c => c[0] === 'error').map(c => String(c[1]));
}

afterEach(() => {
  jest.restoreAllMocks();
  globalLogger.setLevel('error');
});

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------

interface KafkaMessage {
  key?: string;
  value: Buffer | null;
  offset: string;
}

function createKafka(options: { deliverProduced: boolean; retention?: QueueRetentionOptions }) {
  const produced: Array<{ key: string; body: any }> = [];
  let eachMessage: ((payload: { message: KafkaMessage }) => Promise<void>) | null = null;
  let offset = 0;

  const deliverRaw = async (value: Buffer | null, key?: string): Promise<void> => {
    if (!eachMessage) throw new Error('consumer not running');
    await eachMessage({ message: { key, value, offset: String(offset++) } });
  };

  const producer = {
    send: async ({
      messages,
    }: {
      topic: string;
      messages: Array<{ key: string; value: string }>;
    }) => {
      for (const message of messages) {
        produced.push({ key: message.key, body: JSON.parse(message.value) });
        if (options.deliverProduced && eachMessage) {
          setImmediate(() => {
            void deliverRaw(Buffer.from(message.value), message.key);
          });
        }
      }
    },
    disconnect: async () => undefined,
  };

  const consumer = {
    connect: async () => undefined,
    subscribe: async () => undefined,
    run: async (config: { eachMessage: (payload: { message: KafkaMessage }) => Promise<void> }) => {
      eachMessage = config.eachMessage;
    },
    disconnect: async () => undefined,
  };

  const adapter = new KafkaAdapter({}, options.retention);
  const internals = adapter as unknown as { kafka: unknown; producer: unknown };
  internals.kafka = { consumer: () => consumer };
  internals.producer = producer;
  adapter.isReady = true;

  return {
    adapter,
    produced,
    deliverRaw,
    deliver: (body: unknown) => deliverRaw(Buffer.from(JSON.stringify(body))),
  };
}

describe('KafkaAdapter', () => {
  test('runs the handler for a job produced by another process', async () => {
    const kafka = createKafka({ deliverProduced: false });
    const seen: JobContext[] = [];
    await kafka.adapter.process(QUEUE, 1, async job => {
      seen.push(job);
    });

    await kafka.deliver({
      jobId: 'external-1',
      data: { n: 1 },
      options: { attempts: 2 },
      timestamp: 1700000000000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('external-1');
    expect(seen[0].data).toEqual({ n: 1 });
    expect(seen[0].attemptsMade).toBe(0);
    expect(seen[0].timestamp).toBe(1700000000000);

    const job = await kafka.adapter.getJob(QUEUE, 'external-1');
    expect(job?.finishedOn).toBeDefined();
    expect(job?.failedReason).toBeUndefined();
    await kafka.adapter.close();
  });

  test('still runs the handler for a job it enqueued itself', async () => {
    const kafka = createKafka({ deliverProduced: true });
    const seen: JobContext[] = [];
    await kafka.adapter.process(QUEUE, 1, async job => {
      seen.push(job);
    });

    const added = await kafka.adapter.addJob(QUEUE, { n: 2 });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(added.id);
    expect(kafka.produced).toHaveLength(1);
    // First delivery is published exactly as before (no attempt counter)
    expect(Object.keys(kafka.produced[0].body).sort()).toEqual([
      'data',
      'jobId',
      'options',
      'timestamp',
    ]);
    await kafka.adapter.close();
  });

  test('stops re-sending a failing job at the configured attempts', async () => {
    const kafka = createKafka({ deliverProduced: true });
    let runs = 0;
    const attemptsSeen: number[] = [];
    await kafka.adapter.process(QUEUE, 1, async job => {
      runs++;
      attemptsSeen.push(job.attemptsMade);
      throw new Error('always fails');
    });

    const added = await kafka.adapter.addJob(QUEUE, { n: 3 }, { attempts: 3 });
    await settle(250);

    expect(runs).toBe(3);
    expect(attemptsSeen).toEqual([0, 1, 2]);
    // One original message plus two retries, all for the same job id
    expect(kafka.produced).toHaveLength(3);
    expect(kafka.produced.map(message => message.body.jobId)).toEqual([
      added.id,
      added.id,
      added.id,
    ]);
    expect(kafka.produced.slice(1).map(message => message.body.attemptsMade)).toEqual([1, 2]);

    const jobs = await kafka.adapter.getJobs(QUEUE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].attemptsMade).toBe(3);
    expect(jobs[0].failedReason).toBe('always fails');
    await kafka.adapter.close();
  });

  test('honours an attempt count carried in from another process', async () => {
    const kafka = createKafka({ deliverProduced: true });
    let runs = 0;
    await kafka.adapter.process(QUEUE, 1, async () => {
      runs++;
      throw new Error('still failing');
    });

    await kafka.deliver({
      jobId: 'external-2',
      data: {},
      options: { attempts: 3 },
      timestamp: Date.now(),
      attemptsMade: 2,
    });
    await settle(100);

    expect(runs).toBe(1);
    expect(kafka.produced).toHaveLength(0);
    const job = await kafka.adapter.getJob(QUEUE, 'external-2');
    expect(job?.attemptsMade).toBe(3);
    expect(job?.failedReason).toBe('still failing');
    await kafka.adapter.close();
  });

  test('retries a job that fails once and then succeeds', async () => {
    const kafka = createKafka({ deliverProduced: true });
    let runs = 0;
    await kafka.adapter.process(QUEUE, 1, async () => {
      runs++;
      if (runs === 1) throw new Error('first attempt fails');
    });

    const added = await kafka.adapter.addJob(QUEUE, { n: 4 }, { attempts: 3 });
    await settle(150);

    expect(runs).toBe(2);
    expect(kafka.produced).toHaveLength(2);
    const job = await kafka.adapter.getJob(QUEUE, added.id);
    expect(job?.failedReason).toBeUndefined();
    expect(job?.progress).toBe(100);
    await kafka.adapter.close();
  });

  test('skips malformed messages without rejecting eachMessage', async () => {
    const errors = captureErrors();
    const kafka = createKafka({ deliverProduced: false });
    let runs = 0;
    await kafka.adapter.process(QUEUE, 1, async () => {
      runs++;
    });

    await expect(kafka.deliverRaw(Buffer.from('not json at all'))).resolves.toBeUndefined();
    await expect(kafka.deliverRaw(null)).resolves.toBeUndefined();
    await expect(kafka.deliverRaw(Buffer.from('[1,2,3]'))).resolves.toBeUndefined();
    await expect(kafka.deliverRaw(Buffer.from('"text"'))).resolves.toBeUndefined();
    await expect(kafka.deliverRaw(Buffer.from('null'))).resolves.toBeUndefined();

    expect(runs).toBe(0);
    expect(errors().filter(message => message.includes('malformed message'))).toHaveLength(5);
    await kafka.adapter.close();
  });

  test('treats a missing options object as {} (failing handler, no retry loop)', async () => {
    const kafka = createKafka({ deliverProduced: true });
    let runs = 0;
    let opts: unknown;
    await kafka.adapter.process(QUEUE, 1, async job => {
      runs++;
      opts = job.opts;
      throw new Error('boom');
    });

    await expect(kafka.deliver({ jobId: 'no-options', data: 1 })).resolves.toBeUndefined();
    await settle();

    expect(runs).toBe(1);
    expect(opts).toEqual({});
    expect(kafka.produced).toHaveLength(0);
    await kafka.adapter.close();
  });
});

// ---------------------------------------------------------------------------
// RabbitMQ
// ---------------------------------------------------------------------------

interface AmqpMessage {
  content: Buffer;
  properties: { messageId?: string; headers?: Record<string, unknown> };
}

function createRabbit(options: { deliverPublished: boolean; retention?: QueueRetentionOptions }) {
  const published: Array<{ queue: string; body: any; options: any }> = [];
  const acked: AmqpMessage[] = [];
  const nacked: Array<{ message: AmqpMessage; allUpTo: boolean; requeue: boolean }> = [];
  let consume: ((message: AmqpMessage | null) => Promise<void>) | null = null;

  const deliverMessage = async (message: AmqpMessage): Promise<void> => {
    if (!consume) throw new Error('consumer not registered');
    await consume(message);
  };

  const channel = {
    assertQueue: async () => undefined,
    prefetch: async () => undefined,
    consume: async (_queue: string, callback: (message: AmqpMessage | null) => Promise<void>) => {
      consume = callback;
      return { consumerTag: 'tag-1' };
    },
    sendToQueue: (queue: string, content: Buffer, sendOptions: any) => {
      published.push({ queue, body: JSON.parse(content.toString()), options: sendOptions });
      if (options.deliverPublished && consume) {
        setImmediate(() => {
          void deliverMessage({
            content,
            properties: { messageId: sendOptions?.messageId, headers: sendOptions?.headers },
          });
        });
      }
      return true;
    },
    ack: (message: AmqpMessage) => {
      acked.push(message);
    },
    nack: (message: AmqpMessage, allUpTo: boolean, requeue: boolean) => {
      nacked.push({ message, allUpTo, requeue });
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };

  const adapter = new RabbitMQAdapter({}, options.retention);
  const internals = adapter as unknown as { channel: unknown };
  internals.channel = channel;
  adapter.isReady = true;

  const raw = (content: Buffer): AmqpMessage => ({ content, properties: {} });

  return {
    adapter,
    published,
    acked,
    nacked,
    deliverRaw: (content: Buffer) => deliverMessage(raw(content)),
    deliver: (body: unknown) => deliverMessage(raw(Buffer.from(JSON.stringify(body)))),
  };
}

describe('RabbitMQAdapter', () => {
  /** The URL the adapter hands to amqplib's connect() for a connection config. */
  async function connectionUrlFor(config: Record<string, unknown>): Promise<string> {
    const adapter = new RabbitMQAdapter(config);
    const emitter = { on: () => undefined };
    const connect = jest.fn(async (_url: string) => ({
      ...emitter,
      createChannel: async () => emitter,
    }));
    (adapter as unknown as { amqp: unknown }).amqp = { connect };
    await (adapter as unknown as { establishConnection(): Promise<void> }).establishConnection();
    return connect.mock.calls[0][0];
  }

  test('percent-encodes the username and password in the connection URL', async () => {
    const username = 'svc@tenant/a';
    const password = 'p@ss:w/rd#1?x=%41';

    const url = await connectionUrlFor({ host: 'mq.internal', port: 5673, username, password });

    const parsed = new URL(url);
    expect(parsed.protocol).toBe('amqp:');
    expect(parsed.hostname).toBe('mq.internal');
    expect(parsed.port).toBe('5673');
    expect(decodeURIComponent(parsed.username)).toBe(username);
    expect(decodeURIComponent(parsed.password)).toBe(password);
    // Nothing from the credentials spills into the path (vhost), query or fragment
    expect(parsed.pathname).toBe('');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
  });

  test('leaves credentials without reserved characters as written', async () => {
    expect(
      await connectionUrlFor({ host: 'mq.internal', username: 'app', password: 's3cret-pw_1.x' })
    ).toBe('amqp://app:s3cret-pw_1.x@mq.internal:5672');
    expect(await connectionUrlFor({})).toBe('amqp://guest:guest@localhost:5672');
  });

  /** Everything the adapter hands to amqplib's connect() for a connection config. */
  async function connectArgumentsFor(config: Record<string, unknown>): Promise<unknown[]> {
    const adapter = new RabbitMQAdapter(config);
    const emitter = { on: () => undefined };
    const connect = jest.fn(async (..._args: unknown[]) => ({
      ...emitter,
      createChannel: async () => emitter,
    }));
    (adapter as unknown as { amqp: unknown }).amqp = { connect };
    await (adapter as unknown as { establishConnection(): Promise<void> }).establishConnection();
    return connect.mock.calls[0];
  }

  test('connects over TLS for amqps or tls options, on the TLS port', async () => {
    expect(await connectArgumentsFor({ host: 'mq.internal', amqps: true })).toEqual([
      'amqps://guest:guest@mq.internal:5671',
    ]);
    // A configured port is kept
    expect(await connectArgumentsFor({ host: 'mq.internal', port: 5999, amqps: true })).toEqual([
      'amqps://guest:guest@mq.internal:5999',
    ]);

    // TLS options select amqps too, and reach amqplib as its socket options
    const tls = { ca: 'CA PEM', cert: 'CERT PEM', key: 'KEY PEM', servername: 'mq.internal' };
    expect(await connectArgumentsFor({ host: 'mq.internal', tls })).toEqual([
      'amqps://guest:guest@mq.internal:5671',
      tls,
    ]);
    expect(await connectArgumentsFor({ tls: true })).toEqual([
      'amqps://guest:guest@localhost:5671',
    ]);

    // Neither: plaintext, one argument, as before
    expect(await connectArgumentsFor({ tls: false })).toEqual([
      'amqp://guest:guest@localhost:5672',
    ]);
  });

  test('opens the configured virtual host', async () => {
    const url = async (vhost: string) =>
      (await connectArgumentsFor({ host: 'mq.internal', vhost }))[0] as string;

    expect(await url('orders')).toBe('amqp://guest:guest@mq.internal:5672/orders');
    // One path segment, whatever the name contains
    expect(await url('/')).toBe('amqp://guest:guest@mq.internal:5672/%2F');
    expect(await url('team/a b')).toBe('amqp://guest:guest@mq.internal:5672/team%2Fa%20b');
    expect(decodeURIComponent(new URL(await url('team/a b')).pathname.slice(1))).toBe('team/a b');
  });

  test('runs the handler for a job published by another process', async () => {
    const rabbit = createRabbit({ deliverPublished: false });
    const seen: JobContext[] = [];
    await rabbit.adapter.process(QUEUE, 1, async job => {
      seen.push(job);
    });

    await rabbit.deliver({
      jobId: 'external-1',
      data: { n: 1 },
      options: {},
      timestamp: 1700000000000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('external-1');
    expect(seen[0].data).toEqual({ n: 1 });
    expect(rabbit.acked).toHaveLength(1);
    expect(rabbit.nacked).toHaveLength(0);

    const job = await rabbit.adapter.getJob(QUEUE, 'external-1');
    expect(job?.progress).toBe(100);
  });

  test('still runs the handler for a job it enqueued itself', async () => {
    const rabbit = createRabbit({ deliverPublished: true });
    const seen: JobContext[] = [];
    await rabbit.adapter.process(QUEUE, 1, async job => {
      seen.push(job);
    });

    const added = await rabbit.adapter.addJob(QUEUE, { n: 2 });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(added.id);
    expect(rabbit.acked).toHaveLength(1);
    expect(rabbit.published).toHaveLength(1);
  });

  test('retries up to the configured attempts, carrying the count in the message', async () => {
    const rabbit = createRabbit({ deliverPublished: true });
    const attemptsSeen: number[] = [];
    await rabbit.adapter.process(QUEUE, 1, async job => {
      attemptsSeen.push(job.attemptsMade);
      throw new Error('always fails');
    });

    const added = await rabbit.adapter.addJob(QUEUE, { n: 3 }, { attempts: 3 });
    await settle(250);

    expect(attemptsSeen).toEqual([0, 1, 2]);
    expect(rabbit.published).toHaveLength(3);
    expect(rabbit.published.map(message => message.body.jobId)).toEqual([
      added.id,
      added.id,
      added.id,
    ]);
    expect(rabbit.published.slice(1).map(message => message.body.attemptsMade)).toEqual([1, 2]);
    // Every delivery is settled; nothing is left unacknowledged or requeued blind
    expect(rabbit.acked).toHaveLength(3);
    expect(rabbit.nacked).toHaveLength(0);

    const job = await rabbit.adapter.getJob(QUEUE, added.id);
    expect(job?.attemptsMade).toBe(3);
    expect(job?.failedReason).toBe('always fails');
  });

  test('honours an attempt count carried in across a restart', async () => {
    const rabbit = createRabbit({ deliverPublished: true });
    let runs = 0;
    await rabbit.adapter.process(QUEUE, 1, async () => {
      runs++;
      throw new Error('still failing');
    });

    await rabbit.deliver({
      jobId: 'external-2',
      data: {},
      options: { attempts: 3 },
      timestamp: Date.now(),
      attemptsMade: 2,
    });
    await settle(100);

    expect(runs).toBe(1);
    expect(rabbit.published).toHaveLength(0);
    expect(rabbit.acked).toHaveLength(1);
    const job = await rabbit.adapter.getJob(QUEUE, 'external-2');
    expect(job?.attemptsMade).toBe(3);
  });

  test('rejects malformed messages without requeue and without throwing', async () => {
    const errors = captureErrors();
    const rabbit = createRabbit({ deliverPublished: false });
    let runs = 0;
    await rabbit.adapter.process(QUEUE, 1, async () => {
      runs++;
    });

    await expect(rabbit.deliverRaw(Buffer.from('not json at all'))).resolves.toBeUndefined();
    await expect(rabbit.deliverRaw(Buffer.from('[1,2,3]'))).resolves.toBeUndefined();
    await expect(rabbit.deliverRaw(Buffer.from('null'))).resolves.toBeUndefined();

    expect(runs).toBe(0);
    expect(rabbit.acked).toHaveLength(0);
    expect(rabbit.nacked).toHaveLength(3);
    for (const entry of rabbit.nacked) {
      expect(entry.allUpTo).toBe(false);
      expect(entry.requeue).toBe(false);
    }
    expect(errors().filter(message => message.includes('malformed message'))).toHaveLength(3);
  });

  test('treats a missing options object as {} (failing handler is acked once)', async () => {
    const rabbit = createRabbit({ deliverPublished: true });
    let runs = 0;
    let opts: unknown;
    await rabbit.adapter.process(QUEUE, 1, async job => {
      runs++;
      opts = job.opts;
      throw new Error('boom');
    });

    await expect(rabbit.deliver({ jobId: 'no-options', data: 1 })).resolves.toBeUndefined();
    await settle();

    expect(runs).toBe(1);
    expect(opts).toEqual({});
    expect(rabbit.acked).toHaveLength(1);
    expect(rabbit.published).toHaveLength(0);
  });

  test('does not throw when the channel is gone while a job is running', async () => {
    const rabbit = createRabbit({ deliverPublished: false });
    await rabbit.adapter.process(QUEUE, 1, async () => {
      (rabbit.adapter as unknown as { channel: unknown }).channel = null;
    });

    await expect(
      rabbit.deliver({ jobId: 'during-drop', data: 1, options: {} })
    ).resolves.toBeUndefined();
    expect(rabbit.acked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SQS
// ---------------------------------------------------------------------------

class FakeDeleteMessageCommand {
  constructor(public input: { QueueUrl: string; ReceiptHandle: string }) {}
}

function createSqs(handler: (job: JobContext) => Promise<void>, retention?: QueueRetentionOptions) {
  const deleted: string[] = [];
  const adapter = new SQSAdapter({ queueUrl: 'https://sqs.test/000000000000/jobs' }, retention);
  const internals = adapter as unknown as {
    client: unknown;
    DeleteMessageCommand: unknown;
    SendMessageCommand: unknown;
    processors: Map<string, (job: JobContext) => Promise<void>>;
    processMessage: (queueName: string, message: unknown) => Promise<void>;
  };
  internals.client = {
    send: async (command: unknown) => {
      if (command instanceof FakeDeleteMessageCommand) {
        deleted.push(command.input.ReceiptHandle);
      }
      return {};
    },
  };
  internals.DeleteMessageCommand = FakeDeleteMessageCommand;
  internals.SendMessageCommand = class {
    constructor(public input: unknown) {}
  };
  internals.processors.set(QUEUE, handler);
  adapter.isReady = true;

  return {
    adapter,
    deleted,
    receive: (body: string | undefined, receipt: string) =>
      internals.processMessage(QUEUE, {
        MessageId: `mid-${receipt}`,
        ReceiptHandle: receipt,
        Body: body,
      }),
  };
}

describe('SQSAdapter', () => {
  test('logs and deletes a message that is not a JSON job object', async () => {
    const errors = captureErrors();
    let runs = 0;
    const sqs = createSqs(async () => {
      runs++;
    });

    await expect(sqs.receive('not json at all', 'r1')).resolves.toBeUndefined();
    await expect(sqs.receive('[1,2,3]', 'r2')).resolves.toBeUndefined();
    await expect(sqs.receive(undefined, 'r3')).resolves.toBeUndefined();

    expect(runs).toBe(0);
    expect(sqs.deleted).toEqual(['r1', 'r2', 'r3']);
    expect(errors().filter(message => message.includes('malformed message'))).toHaveLength(3);
  });

  test('treats a missing options object as {} (failing handler is deleted after one run)', async () => {
    let runs = 0;
    let opts: unknown;
    const sqs = createSqs(async job => {
      runs++;
      opts = job.opts;
      throw new Error('boom');
    });

    await expect(
      sqs.receive(JSON.stringify({ jobId: 'no-options', data: 1 }), 'r1')
    ).resolves.toBeUndefined();

    expect(runs).toBe(1);
    expect(opts).toEqual({});
    expect(sqs.deleted).toEqual(['r1']);
  });

  test('still processes and deletes a well-formed job from another process', async () => {
    const seen: JobContext[] = [];
    const sqs = createSqs(async job => {
      seen.push(job);
    });

    await sqs.receive(
      JSON.stringify({
        jobId: 'external-1',
        data: { n: 1 },
        options: {},
        timestamp: 1700000000000,
      }),
      'r1'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('external-1');
    expect(seen[0].data).toEqual({ n: 1 });
    expect(seen[0].timestamp).toBe(1700000000000);
    expect(sqs.deleted).toEqual(['r1']);
  });

  test('keeps retrying (no delete) while attempts remain', async () => {
    const sqs = createSqs(async () => {
      throw new Error('boom');
    });
    const body = JSON.stringify({ jobId: 'retry-1', data: 1, options: { attempts: 2 } });

    await sqs.receive(body, 'r1');
    expect(sqs.deleted).toEqual([]);
    await sqs.receive(body, 'r2');
    expect(sqs.deleted).toEqual(['r2']);
  });
});

// ---------------------------------------------------------------------------
// Connection options handed to the client libraries
// ---------------------------------------------------------------------------

describe('broker client configuration', () => {
  const FAKES = path.resolve(__dirname, '../../fixtures/broker-clients-fake');
  const PACKAGES: Record<string, string> = {
    kafkajs: path.join(FAKES, 'kafkajs.cjs'),
    '@aws-sdk/client-sqs': path.join(FAKES, 'client-sqs.cjs'),
  };
  const constructed = (): { kafka: any[]; sqs: any[] } =>
    (globalThis as any).__moroFakeBrokerClients;

  const withFakes = () => {
    (globalThis as any).__moroFakeBrokerClients = { kafka: [], sqs: [] };
    jest.spyOn(packageUtils, 'isPackageAvailable').mockImplementation(name => name in PACKAGES);
    jest.spyOn(packageUtils, 'resolveUserPackage').mockImplementation(name => PACKAGES[name]);
  };

  test('kafka: passes clientId, ssl and sasl to kafkajs', async () => {
    withFakes();
    const ssl = { ca: ['CA PEM'], rejectUnauthorized: true };
    const sasl = { mechanism: 'scram-sha-256', username: 'svc', password: 'pw' };
    const adapter = new KafkaAdapter({ brokers: ['k1:9093'], clientId: 'billing', ssl, sasl });
    await adapter.initialize();
    await adapter.close();

    // Without them the client is configured exactly as before
    const plain = new KafkaAdapter({ brokers: ['k1:9092'] });
    await plain.initialize();
    await plain.close();

    expect(constructed().kafka).toEqual([
      { clientId: 'billing', brokers: ['k1:9093'], ssl, sasl },
      { clientId: 'morojs-queue', brokers: ['k1:9092'] },
    ]);
  });

  test('sqs: passes endpoint and credentials to the client, and builds queue URLs under the endpoint', async () => {
    withFakes();
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
    const adapter = new SQSAdapter({
      region: 'eu-west-1',
      endpoint: 'http://127.0.0.1:9324/',
      credentials,
    });
    await adapter.initialize();
    await adapter.addJob('emails', { n: 1 });

    const [client] = constructed().sqs;
    expect(client.config).toEqual({
      region: 'eu-west-1',
      endpoint: 'http://127.0.0.1:9324/',
      credentials,
    });
    expect(client.sent[0].input.QueueUrl).toBe('http://127.0.0.1:9324/000000000000/emails');
    await adapter.close();

    // Without them the client and the queue URLs are exactly as before
    const plain = new SQSAdapter({ region: 'eu-west-1' });
    await plain.initialize();
    await plain.addJob('emails', { n: 1 });

    const plainClient = constructed().sqs[1];
    expect(plainClient.config).toEqual({ region: 'eu-west-1' });
    expect(plainClient.sent[0].input.QueueUrl).toBe(
      'https://sqs.eu-west-1.amazonaws.com/000000000000/emails'
    );
    await plain.close();
  });
});

// ---------------------------------------------------------------------------
// Retention of job records (the same contract on each broker adapter)
// ---------------------------------------------------------------------------

describe('job records kept in memory', () => {
  const retention = { completed: 2, failed: 3, unfinished: 4 };
  const failsWhenOdd = async (job: JobContext) => {
    if ((job.data as { n: number }).n % 2 === 1) throw new Error('odd');
  };
  const numbers = (jobs: Array<{ data: unknown }>) =>
    jobs.map(job => (job.data as { n: number }).n);
  const message = (n: number, options: Record<string, unknown> = {}) => ({
    jobId: `job-${n}`,
    data: { n },
    options,
  });

  // Each entry: an adapter whose consumer is fed by `deliver`, never by what it adds
  const brokers: Record<
    string,
    (options?: QueueRetentionOptions) => Promise<{
      adapter: KafkaAdapter | RabbitMQAdapter | SQSAdapter;
      deliver: (n: number, options?: Record<string, unknown>) => Promise<void>;
    }>
  > = {
    kafka: async options => {
      const kafka = createKafka({ deliverProduced: false, retention: options });
      await kafka.adapter.process(QUEUE, 1, failsWhenOdd);
      return { adapter: kafka.adapter, deliver: (n, o) => kafka.deliver(message(n, o)) };
    },
    rabbitmq: async options => {
      const rabbit = createRabbit({ deliverPublished: false, retention: options });
      await rabbit.adapter.process(QUEUE, 1, failsWhenOdd);
      return { adapter: rabbit.adapter, deliver: (n, o) => rabbit.deliver(message(n, o)) };
    },
    sqs: async options => {
      const sqs = createSqs(failsWhenOdd, options);
      return {
        adapter: sqs.adapter,
        deliver: (n, o) => sqs.receive(JSON.stringify(message(n, o)), `r${n}`),
      };
    },
  };

  for (const [name, create] of Object.entries(brokers)) {
    test(`${name}: keeps the most recent completed and failed jobs, and drops older ones`, async () => {
      const { adapter, deliver } = await create(retention);

      for (let n = 0; n < 20; n++) await deliver(n);

      expect(numbers(await adapter.getJobs(QUEUE, 'completed'))).toEqual([16, 18]);
      expect(numbers(await adapter.getJobs(QUEUE, 'failed'))).toEqual([15, 17, 19]);
      expect(await adapter.getJobs(QUEUE)).toHaveLength(5);
      await adapter.close();
    });

    test(`${name}: bounds the records of jobs it added and never saw finish`, async () => {
      const { adapter, deliver } = await create(retention);

      // A process that only adds jobs: another process consumes them
      for (let n = 0; n < 10; n++) await adapter.addJob(QUEUE, { n }, { jobId: `job-${n}` });
      expect(numbers(await adapter.getJobs(QUEUE))).toEqual([6, 7, 8, 9]);

      // A job whose record was dropped still runs when its message arrives
      await deliver(2);
      expect(numbers(await adapter.getJobs(QUEUE, 'completed'))).toEqual([2]);
      expect(await adapter.getJobs(QUEUE)).toHaveLength(4);
      await adapter.close();
    });

    test(`${name}: keeps 1000 completed, 5000 failed and 10000 unfinished records by default`, async () => {
      const { adapter, deliver } = await create();

      for (let n = 0; n < 2200; n += 2) await deliver(n);
      expect(await adapter.getJobs(QUEUE, 'completed')).toHaveLength(1000);
      expect(numbers(await adapter.getJobs(QUEUE, 'completed'))[0]).toBe(200);

      const limits = (adapter as unknown as { retention: Record<string, number> }).retention;
      expect([limits.completed, limits.failed, limits.unfinished]).toEqual([1000, 5000, 10000]);
      await adapter.close();
    });

    test(`${name}: leaves a job with its own removeOnComplete setting to that setting`, async () => {
      const { adapter, deliver } = await create(retention);
      for (const n of [0, 2, 4]) await deliver(n, { removeOnComplete: false });
      for (const n of [10, 12, 14]) await deliver(n);

      expect(numbers(await adapter.getJobs(QUEUE, 'completed'))).toEqual([0, 2, 4, 12, 14]);
      await adapter.close();
    });
  }
});

// ---------------------------------------------------------------------------
// Shared decoder
// ---------------------------------------------------------------------------

describe('decodeJobMessage', () => {
  test('returns null for anything that is not a JSON object', () => {
    for (const raw of [undefined, null, 42, '', 'nope', '42', '"s"', 'null', '[]', '{bad']) {
      expect(decodeJobMessage(raw)).toBeNull();
    }
    expect(decodeJobMessage(Buffer.from('nope'))).toBeNull();
  });

  test('decodes strings and buffers and fills defaults', () => {
    const fromString = decodeJobMessage('{"jobId":"a","data":{"x":1}}');
    expect(fromString).toMatchObject({ jobId: 'a', data: { x: 1 }, options: {}, attemptsMade: 0 });
    expect(typeof fromString?.timestamp).toBe('number');

    const fromBuffer = decodeJobMessage(
      Buffer.from('{"jobId":"b","options":{"attempts":2},"timestamp":5,"attemptsMade":1}')
    );
    expect(fromBuffer).toMatchObject({
      jobId: 'b',
      options: { attempts: 2 },
      timestamp: 5,
      attemptsMade: 1,
    });
  });

  test('ignores a non-object options value and a bogus attempt count', () => {
    expect(decodeJobMessage('{"jobId":"a","options":"x","attemptsMade":"3"}')).toMatchObject({
      options: {},
      attemptsMade: 0,
    });
    expect(decodeJobMessage('{"jobId":"a","options":[1],"attemptsMade":-4}')).toMatchObject({
      options: {},
      attemptsMade: 0,
    });
  });

  test('falls back to the broker message id, then a generated id', () => {
    expect(decodeJobMessage('{"data":1}', 'broker-id')?.jobId).toBe('broker-id');
    expect(decodeJobMessage('{"data":1}')?.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
