// gRPC Integration Tests
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as net from 'net';
import * as tls from 'tls';
import * as path from 'path';
import { createApp, grpcAuth, grpcRequireRole } from '../../src/index.js';
import type { Moro } from '../../src/moro.js';
import type { GrpcCall, GrpcClient } from '../../src/core/grpc/types.js';
import { isPackageAvailable, resolveUserPackage } from '../../src/core/utilities/package-utils.js';
import { MoroLogger } from '../../src/core/logger/index.js';
import { fixture } from '../utils/tls-client.js';

describe('gRPC Integration', () => {
  describe('gRPC Initialization', () => {
    let app: Moro;

    beforeAll(async () => {
      app = await createApp({
        server: {
          port: 3999,
        },
        logger: { level: 'error' },
      });
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('should gracefully handle gRPC when packages are not installed', async () => {
      // Try to initialize gRPC without @grpc/grpc-js installed
      // Should throw a helpful error message
      try {
        await app.grpcInit({
          port: 50051,
          adapter: 'grpc-js',
        });

        // If we get here, gRPC packages are installed
        expect(app.getGrpcStats).toBeDefined();
        expect(app.getGrpcServices).toBeDefined();
      } catch (error) {
        // Expected error when @grpc/grpc-js is not installed
        expect((error as Error).message).toContain('@grpc/grpc-js');
        expect((error as Error).message).toContain('npm install');
      }
    });

    it('should have gRPC methods available', () => {
      expect(app.grpcInit).toBeDefined();
      expect(app.grpcService).toBeDefined();
      expect(app.startGrpc).toBeDefined();
      expect(app.stopGrpc).toBeDefined();
      expect(app.createGrpcClient).toBeDefined();
      expect(app.getGrpcStats).toBeDefined();
      expect(app.getGrpcServices).toBeDefined();
    });

    it('should return null for gRPC stats when not initialized', () => {
      const stats = app.getGrpcStats();
      expect(stats).toBeNull();
    });

    it('should return empty array for gRPC services when not initialized', () => {
      const services = app.getGrpcServices();
      expect(services).toEqual([]);
    });
  });

  describe('gRPC Error Handling', () => {
    let app: Moro;

    beforeAll(async () => {
      app = await createApp({
        server: {
          port: 4000,
        },
        logger: { level: 'error' },
      });
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('should throw error when registering service without initialization', async () => {
      await expect(app.grpcService('./proto/test.proto', 'TestService', {})).rejects.toThrow(
        'not initialized'
      );
    });

    it('should throw error when creating client without initialization', async () => {
      await expect(
        app.createGrpcClient('./proto/test.proto', 'TestService', 'localhost:50051')
      ).rejects.toThrow('not initialized');
    });
  });
});

describe('gRPC Types Export', () => {
  it('should export gRPC types from main package', async () => {
    const exports = await import('../../src/index.js');

    // Check type exports (these won't be runtime values, just verify they're in the module)
    expect(exports).toBeDefined();
    expect(typeof exports.createApp).toBe('function');
  });
});

// Real calls over loopback with the real @grpc/grpc-js and @grpc/proto-loader.
// One side of every call is MoroJS and the other is plain grpc-js built from
// the same .proto, so the two only understand each other if MoroJS speaks
// standard gRPC: protobuf messages, the status codes and metadata of the
// protocol, and the TLS or plaintext channel that was asked for.
//
// Both packages are optional peer dependencies: without them the suite is
// reported as skipped.
const grpcPackagesInstalled =
  isPackageAvailable('@grpc/grpc-js') && isPackageAvailable('@grpc/proto-loader');
const describeOnTheWire = grpcPackagesInstalled ? describe : describe.skip;

describeOnTheWire('gRPC on the wire', () => {
  const PROTO = path.join(__dirname, '..', 'fixtures', 'grpc', 'inventory.proto');

  type Callback = (error: any, response?: any) => void;
  type Answer = { error: any; response?: any };

  // One item that uses every kind of field in the .proto: nested messages (two
  // levels), repeated messages and scalars, an enum, an int64 beyond 2^53,
  // bytes and a map. `longs: String` and `enums: String` are the loader options
  // MoroJS uses, so the plain side is loaded the same way.
  const widget = {
    id: 'w-1',
    name: 'Widget',
    quantity: '9007199254740993',
    status: 'ACTIVE',
    tags: [
      { key: 'colour', value: 'red' },
      { key: 'size', value: 'L' },
    ],
    supplier: { name: 'Acme', address: { city: 'Lyon', country: 'FR' } },
    bins: [3, 1, 4, 1, 5],
    checksum: Buffer.from([0, 255, 16, 32]),
    attributes: { origin: 'eu' },
  };
  // Mostly defaults: zero-length lists and map, a negative int64, another enum value
  const gadget = {
    ...widget,
    id: 'g-2',
    name: 'Gadget',
    quantity: '-5',
    status: 'RETIRED',
    tags: [],
    bins: [],
    attributes: {},
  };
  const stock = [widget, gadget];

  let grpc: any;
  let Inventory: any;

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  const unary = (client: any, method: string, ...args: unknown[]) =>
    new Promise<Answer>(resolve =>
      client[method](...args, (error: any, response: any) => resolve({ error, response }))
    );

  const drain = (stream: any) =>
    new Promise<{ items: any[]; error?: any }>(resolve => {
      const items: any[] = [];
      stream.on('data', (item: any) => items.push(item));
      stream.on('error', (error: any) => resolve({ items, error }));
      stream.on('end', () => setImmediate(() => resolve({ items })));
    });

  const metadataOf = (values: Record<string, string | Buffer>) => {
    const metadata = new grpc.Metadata();
    for (const [key, value] of Object.entries(values)) metadata.set(key, value);
    return metadata;
  };

  /** The Inventory service, written once and served by MoroJS and by plain grpc-js. */
  const inventory = (seen: Record<string, any>) => ({
    getItem(call: GrpcCall, callback: Callback) {
      seen.request = call.request;
      seen.tenant = call.metadata.get('x-tenant');
      seen.trace = call.metadata.get('trace-bin');
      const { id } = call.request;
      if (id === 'missing') {
        return callback({ code: grpc.status.NOT_FOUND, message: `Item ${id} not found` });
      }
      if (id === 'trailers') {
        return callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'Invalid item ID',
          metadata: metadataOf({ 'error-code': 'ITEM_ID_INVALID' }),
        });
      }
      if (id === 'boom') throw new Error('database exploded');
      if (id === 'lost') throw new Error('row not found in /var/lib/app/items.db');
      if (id === 'coded') {
        throw Object.assign(new Error('quota used up'), {
          code: grpc.status.RESOURCE_EXHAUSTED,
          metadata: metadataOf({ 'retry-after': '30' }),
        });
      }
      if (id === 'headers') call.sendMetadata(metadataOf({ 'x-served-by': 'inventory-1' }));
      callback(null, stock.find(item => item.id === id) ?? { ...widget, id });
    },
    async listItems(call: GrpcCall) {
      const { status, limit } = call.request;
      if (limit < 0) {
        throw Object.assign(new Error('limit must not be negative'), {
          code: grpc.status.OUT_OF_RANGE,
        });
      }
      const wanted = stock.filter(
        item => status === 'STATUS_UNSPECIFIED' || item.status === status
      );
      for (const item of wanted.slice(0, limit || undefined)) call.write?.(item);
      call.end?.();
    },
    importItems(call: GrpcCall, callback: Callback) {
      const received: any[] = [];
      call.on?.('data', item => received.push(item));
      call.on?.('end', () => {
        seen.imported = received;
        callback(null, {
          count: received.length,
          total_quantity: received
            .reduce((sum, item) => sum + BigInt(item.quantity), BigInt(0))
            .toString(),
          ids: received.map(item => item.id),
        });
      });
    },
    adjust(call: GrpcCall) {
      const tenant = String(call.metadata.get('x-tenant'));
      call.on?.('data', adjustment => {
        if (adjustment.id === 'bad') {
          (call as any).emit('error', {
            code: grpc.status.FAILED_PRECONDITION,
            message: 'cannot adjust',
          });
          return;
        }
        call.write?.({
          ...widget,
          id: adjustment.id,
          name: `adjusted by ${tenant}`,
          quantity: (BigInt(widget.quantity) + BigInt(adjustment.delta)).toString(),
        });
      });
      call.on?.('end', () => call.end?.());
    },
  });

  /**
   * The calls every pairing must get right. `call` makes a unary call in the
   * style of the client under test and reports `{ error, response }`.
   */
  function messagesAndStreams(
    client: () => any,
    seen: Record<string, any>,
    call: (method: string, request: unknown, metadata?: unknown) => Promise<Answer>
  ) {
    it('carries nested messages, repeated fields, enums, int64, bytes and maps', async () => {
      const { error, response } = await call('GetItem', { id: 'w-1' });

      expect(error).toBeNull();
      expect(response).toEqual(widget);
      // int64 beyond Number.MAX_SAFE_INTEGER arrives intact, as a string
      expect(response.quantity).toBe('9007199254740993');
      expect(Buffer.isBuffer(response.checksum)).toBe(true);
      expect(seen.request).toEqual({ id: 'w-1' });
    });

    it('fills in defaults for fields that were not set', async () => {
      const { response } = await call('GetItem', { id: 'g-2' });
      expect(response).toEqual(gadget);
    });

    it('delivers request metadata to the handler, text and binary', async () => {
      await call(
        'GetItem',
        { id: 'w-1' },
        metadataOf({ 'x-tenant': 'tenant-7', 'trace-bin': Buffer.from([1, 2, 3]) })
      );

      expect(seen.tenant).toEqual(['tenant-7']);
      expect(seen.trace).toEqual([Buffer.from([1, 2, 3])]);
    });

    it('reports a status object passed to the callback, with its trailing metadata', async () => {
      const missing = await call('GetItem', { id: 'missing' });
      expect(missing.error.code).toBe(grpc.status.NOT_FOUND);
      expect(missing.error.details).toBe('Item missing not found');

      const invalid = await call('GetItem', { id: 'trailers' });
      expect(invalid.error.code).toBe(grpc.status.INVALID_ARGUMENT);
      expect(invalid.error.metadata.get('error-code')).toEqual(['ITEM_ID_INVALID']);
    });

    it('streams responses (server streaming)', async () => {
      const all = await drain(client().ListItems({ status: 'STATUS_UNSPECIFIED', limit: 0 }));
      expect(all.error).toBeUndefined();
      expect(all.items).toEqual(stock);

      // The enum travels in the request too
      const retired = await drain(client().ListItems({ status: 'RETIRED', limit: 10 }));
      expect(retired.items).toEqual([gadget]);
    });

    it('streams requests (client streaming)', async () => {
      const answer = await new Promise<Answer>(resolve => {
        const stream = client().ImportItems(
          metadataOf({ authorization: 'Bearer admin-token' }),
          (error: any, response: any) => resolve({ error, response })
        );
        stream.write(widget);
        stream.write(gadget);
        stream.write({ id: 'x-3', quantity: '12' });
        stream.end();
      });

      expect(answer.error).toBeNull();
      expect(answer.response).toEqual({
        count: 3,
        total_quantity: '9007199254741000',
        ids: ['w-1', 'g-2', 'x-3'],
      });
      expect(seen.imported[0]).toEqual(widget);
    });

    it('streams both ways (bidirectional)', async () => {
      const stream = client().Adjust(metadataOf({ 'x-tenant': 'tenant-9' }));
      const drained = drain(stream);
      stream.write({ id: 'a', delta: '7' });
      stream.write({ id: 'b', delta: '-9007199254740993' });
      stream.end();
      const { items, error } = await drained;

      expect(error).toBeUndefined();
      expect(items.map(item => [item.id, item.name, item.quantity])).toEqual([
        ['a', 'adjusted by tenant-9', '9007199254741000'],
        ['b', 'adjusted by tenant-9', '0'],
      ]);
    });
  }

  beforeAll(async () => {
    // The same module instances the framework loads
    grpc = await import(resolveUserPackage('@grpc/grpc-js'));
    const protoLoader = await import(resolveUserPackage('@grpc/proto-loader'));
    const definition = await protoLoader.load(PROTO, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    Inventory = grpc.loadPackageDefinition(definition).acme.inventory.v1.Inventory;
  });

  describe('a plain grpc-js client calling a MoroJS server', () => {
    let app: Moro;
    let address: string;
    let client: any;
    const seen: Record<string, any> = {};
    const order: string[] = [];
    const users: Record<string, object> = {
      'admin-token': { id: 1, roles: ['admin'] },
      'user-token': { id: 2, roles: ['user'] },
    };

    beforeAll(async () => {
      const port = await freePort();
      address = `127.0.0.1:${port}`;
      app = await createApp({ logger: { level: 'error' } });
      app.grpcInit({ port, host: '127.0.0.1' });

      const handlers = inventory(seen);
      await app.grpcService(PROTO, 'Inventory', {
        // Two middleware, then the handler
        GetItem: [
          async () => {
            order.push('first');
          },
          async (_call: GrpcCall, _callback: Callback, next: () => Promise<void>) => {
            order.push('second: before');
            await next();
            order.push('second: after');
          },
          async (call: GrpcCall, callback: Callback) => {
            order.push('handler');
            return handlers.getItem(call, callback);
          },
        ] as any,
        ListItems: handlers.listItems,
        ImportItems: [
          grpcAuth({ verify: async token => users[token] ?? null }),
          grpcRequireRole('admin'),
          handlers.importItems,
        ],
        Adjust: handlers.adjust,
      });
      await app.startGrpc();

      client = new Inventory(address, grpc.credentials.createInsecure());
    });

    afterAll(async () => {
      client?.close();
      await app?.stopGrpc();
      await app?.close();
    });

    it('registers the service with the methods of the .proto', () => {
      expect(app.getGrpcServices()).toEqual([
        { serviceName: 'Inventory', methods: ['GetItem', 'ListItems', 'ImportItems', 'Adjust'] },
      ]);
    });

    messagesAndStreams(
      () => client,
      seen,
      (method, request, metadata) =>
        metadata ? unary(client, method, request, metadata) : unary(client, method, request)
    );

    it('puts protobuf in the response frame', async () => {
      const identity = (bytes: Buffer) => bytes;
      const Raw = grpc.makeGenericClientConstructor(
        {
          GetItem: {
            path: '/acme.inventory.v1.Inventory/GetItem',
            requestStream: false,
            responseStream: false,
            requestSerialize: Inventory.service.GetItem.requestSerialize,
            requestDeserialize: identity,
            responseSerialize: identity,
            responseDeserialize: identity,
          },
        },
        'Raw'
      );
      const raw = new Raw(address, grpc.credentials.createInsecure());
      const { error, response } = await unary(raw, 'GetItem', { id: 'w-1' });
      raw.close();

      expect(error).toBeNull();
      expect(Buffer.isBuffer(response)).toBe(true);
      // Field 1 (id), length-delimited, "w-1": 0a 03 77 2d 31
      expect(response.subarray(0, 5).toString('hex')).toBe('0a03772d31');
      expect(() => JSON.parse(response.toString())).toThrow();
      expect(Inventory.service.GetItem.responseDeserialize(response)).toEqual(widget);
    });

    it('runs a handler array in order: middleware, then the handler', async () => {
      order.length = 0;
      await unary(client, 'GetItem', { id: 'w-1' });
      expect(order).toEqual(['first', 'second: before', 'handler', 'second: after']);
    });

    it('answers a thrown error with INTERNAL, or with the gRPC code the error carries', async () => {
      const plain = await unary(client, 'GetItem', { id: 'boom' });
      expect(plain.error.code).toBe(grpc.status.INTERNAL);
      expect(plain.error.details).toBe('database exploded');

      const coded = await unary(client, 'GetItem', { id: 'coded' });
      expect(coded.error.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
      expect(coded.error.details).toBe('quota used up');
      expect(coded.error.metadata.get('retry-after')).toEqual(['30']);
    });

    it('in production, keeps the text of an error the handler gave no status to itself, and logs it', async () => {
      const environment = process.env.NODE_ENV;
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      process.env.NODE_ENV = 'production';
      try {
        const plain = await unary(client, 'GetItem', { id: 'boom' });
        expect(plain.error.code).toBe(grpc.status.INTERNAL);
        expect(plain.error.details).toBe('Internal server error');

        // The status is still picked from the text; the text stays here
        const lost = await unary(client, 'GetItem', { id: 'lost' });
        expect(lost.error.code).toBe(grpc.status.NOT_FOUND);
        expect(lost.error.details).toBe('Not found');

        const logged = log.mock.calls
          .filter(call => call[0] === 'error')
          .map(call => String(call[1]));
        expect(logged).toEqual([
          'gRPC call GetItem failed: database exploded',
          'gRPC call GetItem failed: row not found in /var/lib/app/items.db',
        ]);

        // A status the handler chose is the handler speaking to the client
        const coded = await unary(client, 'GetItem', { id: 'coded' });
        expect(coded.error.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
        expect(coded.error.details).toBe('quota used up');
        expect(coded.error.metadata.get('retry-after')).toEqual(['30']);
        const missing = await unary(client, 'GetItem', { id: 'missing' });
        expect(missing.error.details).toBe('Item missing not found');

        const thrown = await drain(client.ListItems({ limit: -1 }));
        expect(thrown.error.code).toBe(grpc.status.OUT_OF_RANGE);
        expect(thrown.error.details).toBe('limit must not be negative');
      } finally {
        process.env.NODE_ENV = environment;
        log.mockRestore();
      }

      // Outside production the text reaches the client, as it always did
      const lost = await unary(client, 'GetItem', { id: 'lost' });
      expect(lost.error.code).toBe(grpc.status.NOT_FOUND);
      expect(lost.error.details).toBe('row not found in /var/lib/app/items.db');
    });

    it('ends a stream with the status of an error thrown or emitted by the handler', async () => {
      const thrown = await drain(client.ListItems({ limit: -1 }));
      expect(thrown.items).toEqual([]);
      expect(thrown.error.code).toBe(grpc.status.OUT_OF_RANGE);
      expect(thrown.error.details).toBe('limit must not be negative');

      const stream = client.Adjust(metadataOf({ 'x-tenant': 't' }));
      const drained = drain(stream);
      stream.write({ id: 'bad', delta: '1' });
      const emitted = await drained;
      expect(emitted.error.code).toBe(grpc.status.FAILED_PRECONDITION);
      expect(emitted.error.details).toBe('cannot adjust');
    });

    it('sends response metadata from the handler to the client', async () => {
      const served = await new Promise((resolve, reject) => {
        const call = client.GetItem({ id: 'headers' }, (error: any) => error && reject(error));
        call.on('metadata', (metadata: any) => resolve(metadata.get('x-served-by')));
      });
      expect(served).toEqual(['inventory-1']);
    });

    it('applies grpcAuth and grpcRequireRole placed before a handler', async () => {
      const importAs = (token?: string) =>
        new Promise<Answer>(resolve => {
          const stream = client.ImportItems(
            token ? metadataOf({ authorization: `Bearer ${token}` }) : new grpc.Metadata(),
            (error: any, response: any) => resolve({ error, response })
          );
          stream.on('error', () => undefined);
          stream.write(widget);
          stream.end();
        });

      expect((await importAs()).error.code).toBe(grpc.status.UNAUTHENTICATED);
      expect((await importAs('user-token')).error.code).toBe(grpc.status.PERMISSION_DENIED);
      const admin = await importAs('admin-token');
      expect(admin.error).toBeNull();
      expect(admin.response.count).toBe(1);
    });

    it('answers a standard health probe', async () => {
      const identity = (bytes: Buffer) => bytes;
      const Health = grpc.makeGenericClientConstructor(
        {
          Check: {
            path: '/grpc.health.v1.Health/Check',
            requestStream: false,
            responseStream: false,
            // HealthCheckRequest { service: "x" } on the wire
            requestSerialize: () => Buffer.from([0x0a, 0x01, 0x78]),
            requestDeserialize: identity,
            responseSerialize: identity,
            responseDeserialize: identity,
          },
        },
        'Health'
      );
      const probe = new Health(address, grpc.credentials.createInsecure());
      const { error, response } = await unary(probe, 'Check', {});
      probe.close();

      expect(error).toBeNull();
      // HealthCheckResponse { status: SERVING } on the wire
      expect(response.toString('hex')).toBe('0801');
    });

    it('counts the calls', async () => {
      const before = app.getGrpcStats();
      const callsBefore = before?.byMethod.GetItem?.calls ?? 0;

      await unary(client, 'GetItem', { id: 'w-1' });
      await unary(client, 'GetItem', { id: 'boom' });

      const after = app.getGrpcStats();
      expect(after?.totalCalls).toBe((before?.totalCalls ?? 0) + 2);
      expect(after?.failedCalls).toBe((before?.failedCalls ?? 0) + 1);
      expect(after?.byMethod.GetItem.calls).toBe(callsBefore + 2);
      expect(after?.activeCalls).toBe(0);
    });
  });

  describe('a MoroJS client calling a plain grpc-js server', () => {
    let app: Moro;
    let server: any;
    let address: string;
    let client: GrpcClient;
    const seen: Record<string, any> = {};

    beforeAll(async () => {
      server = new grpc.Server();
      // grpc-js finds handlers by lower-camel-case name
      server.addService(Inventory.service, inventory(seen));
      const port = await new Promise<number>((resolve, reject) =>
        server.bindAsync(
          '127.0.0.1:0',
          grpc.ServerCredentials.createInsecure(),
          (error: Error | null, bound: number) => (error ? reject(error) : resolve(bound))
        )
      );
      address = `127.0.0.1:${port}`;

      app = await createApp({ logger: { level: 'error' } });
      app.grpcInit({ port: await freePort(), host: '127.0.0.1' });
      client = await app.createGrpcClient(PROTO, 'Inventory', address);
    });

    afterAll(async () => {
      client?.close();
      server?.forceShutdown();
      await app?.close();
    });

    // Unary calls in the promise form
    messagesAndStreams(
      () => client,
      seen,
      async (method, request, metadata) => {
        try {
          const pending = metadata
            ? (client as any)[method](request, metadata)
            : (client as any)[method](request);
          return { error: null, response: await pending };
        } catch (error) {
          return { error };
        }
      }
    );

    it('keeps the callback form of a unary call, which returns the grpc-js call', async () => {
      let call: any;
      const answer = await new Promise<Answer>(resolve => {
        call = (client as any).GetItem({ id: 'w-1' }, (error: any, response: any) =>
          resolve({ error, response })
        );
      });

      expect(answer.error).toBeNull();
      expect(answer.response).toEqual(widget);
      expect(typeof call.cancel).toBe('function');
      expect(call).not.toBeInstanceOf(Promise);
    });

    it('takes metadata and call options in the promise form', async () => {
      const response = await client.GetItem(
        { id: 'w-1' },
        metadataOf({ 'x-tenant': 'tenant-42' }),
        {
          deadline: Date.now() + 5000,
        }
      );

      expect(response.id).toBe('w-1');
      expect(seen.tenant).toEqual(['tenant-42']);
    });

    it('offers every method under its lower-camel-case name', async () => {
      await expect((client as any).getItem({ id: 'g-2' })).resolves.toEqual(gadget);
      const { items } = await drain((client as any).listItems({ status: 'ACTIVE', limit: 5 }));
      expect(items).toEqual([widget]);
    });

    it('finds the service by its package-qualified name', async () => {
      const qualified = await app.createGrpcClient(PROTO, 'acme.inventory.v1.Inventory', address);
      await expect(qualified.GetItem({ id: 'w-1' })).resolves.toEqual(widget);
      qualified.close();
    });
  });

  describe('a MoroJS server whose handlers use lower-camel-case names', () => {
    let app: Moro;
    let client: any;
    const seen: Record<string, any> = {};

    beforeAll(async () => {
      const port = await freePort();
      app = await createApp({ logger: { level: 'error' } });
      app.grpcInit({ port, host: '127.0.0.1', enableHealthCheck: false });
      await app.grpcService(PROTO, 'acme.inventory.v1.Inventory', inventory(seen));
      await app.startGrpc();
      client = new Inventory(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    });

    afterAll(async () => {
      client?.close();
      await app?.stopGrpc();
      await app?.close();
    });

    messagesAndStreams(
      () => client,
      seen,
      (method, request, metadata) =>
        metadata ? unary(client, method, request, metadata) : unary(client, method, request)
    );
  });

  describe('channel credentials', () => {
    let app: Moro;
    const ca = Buffer.from(fixture('ca.pem'));
    const key = Buffer.from(fixture('localhost.key'));
    const cert = Buffer.from(fixture('localhost.pem'));

    beforeAll(async () => {
      app = await createApp({ logger: { level: 'error' } });
      app.grpcInit({ port: await freePort(), host: '127.0.0.1' });
    });

    afterAll(async () => {
      await app?.close();
    });

    /**
     * What a MoroJS client created with these credentials sends first: a TLS
     * ClientHello, or the cleartext HTTP/2 connection preface.
     */
    async function firstBytesFrom(credentials?: unknown): Promise<string> {
      const listener = net.createServer();
      const first = new Promise<Buffer>(resolve => {
        listener.on('connection', socket => {
          socket.on('error', () => undefined);
          socket.once('data', data => {
            resolve(data);
            socket.destroy();
          });
        });
      });
      await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
      const { port } = listener.address() as net.AddressInfo;

      const client = await app.createGrpcClient(
        PROTO,
        'Inventory',
        `localhost:${port}`,
        credentials === undefined ? undefined : { credentials: credentials as any }
      );
      (client as any).GetItem({ id: 'x' }, { deadline: Date.now() + 5000 }, () => undefined);
      const data = await first;
      client.close();
      await new Promise(resolve => listener.close(resolve));

      // TLS record: handshake (0x16), version 3.x
      return data[0] === 0x16 && data[1] === 0x03
        ? 'TLS ClientHello'
        : data.subarray(0, 14).toString('latin1');
    }

    it('opens a plaintext channel without credentials', async () => {
      expect(await firstBytesFrom()).toBe('PRI * HTTP/2.0');
    });

    it("opens a plaintext channel for credentials: 'insecure'", async () => {
      expect(await firstBytesFrom('insecure')).toBe('PRI * HTTP/2.0');
    });

    it('uses grpc-js channel credentials as given', async () => {
      expect(await firstBytesFrom(grpc.credentials.createInsecure())).toBe('PRI * HTTP/2.0');
      expect(await firstBytesFrom(grpc.credentials.createSsl(ca))).toBe('TLS ClientHello');
    });

    it('opens a TLS channel for PEM credentials', async () => {
      expect(await firstBytesFrom({ rootCerts: ca })).toBe('TLS ClientHello');
      expect(await firstBytesFrom({})).toBe('TLS ClientHello');
    });

    describe('over TLS', () => {
      let tlsApp: Moro;
      let moroTlsPort: number;
      let plainTlsServer: any;
      let plainTlsPort: number;

      beforeAll(async () => {
        moroTlsPort = await freePort();
        tlsApp = await createApp({ logger: { level: 'error' } });
        tlsApp.grpcInit({
          port: moroTlsPort,
          host: '127.0.0.1',
          credentials: { privateKey: key, certChain: cert },
        });
        await tlsApp.grpcService(PROTO, 'Inventory', inventory({}));
        await tlsApp.startGrpc();

        plainTlsServer = new grpc.Server();
        plainTlsServer.addService(Inventory.service, inventory({}));
        plainTlsPort = await new Promise<number>((resolve, reject) =>
          plainTlsServer.bindAsync(
            '127.0.0.1:0',
            grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }], false),
            (error: Error | null, bound: number) => (error ? reject(error) : resolve(bound))
          )
        );
      });

      afterAll(async () => {
        plainTlsServer?.forceShutdown();
        await tlsApp?.stopGrpc();
        await tlsApp?.close();
      });

      it('serves TLS with the configured certificate', async () => {
        const peer = await new Promise<object>((resolve, reject) => {
          const socket = tls.connect(
            { host: 'localhost', port: moroTlsPort, ca, ALPNProtocols: ['h2'] },
            () => {
              resolve({
                subject: socket.getPeerCertificate().subject.CN,
                protocol: socket.alpnProtocol,
                authorized: socket.authorized,
              });
              socket.destroy();
            }
          );
          socket.on('error', reject);
        });

        expect(peer).toEqual({ subject: 'localhost', protocol: 'h2', authorized: true });
      });

      it('a plain grpc-js TLS client calls a MoroJS TLS server', async () => {
        const client = new Inventory(`localhost:${moroTlsPort}`, grpc.credentials.createSsl(ca));
        const { error, response } = await unary(client, 'GetItem', { id: 'w-1' });
        client.close();

        expect(error).toBeNull();
        expect(response).toEqual(widget);
      });

      it('a MoroJS TLS server refuses a plaintext client', async () => {
        const client = new Inventory(`localhost:${moroTlsPort}`, grpc.credentials.createInsecure());
        const { error } = await unary(
          client,
          'GetItem',
          { id: 'w-1' },
          { deadline: Date.now() + 3000 }
        );
        client.close();

        expect(error).toBeTruthy();
      });

      it('refuses a client with no certificate when one is required, under either name of the option', async () => {
        for (const option of [{ requireClientCert: true }, { checkServerIdentity: true }]) {
          const port = await freePort();
          const mtlsApp = await createApp({ logger: { level: 'error' } });
          mtlsApp.grpcInit({
            port,
            host: '127.0.0.1',
            credentials: { rootCerts: ca, privateKey: key, certChain: cert, ...option },
          });
          await mtlsApp.grpcService(PROTO, 'Inventory', inventory({}));
          await mtlsApp.startGrpc();
          try {
            // Trusts the server, presents no certificate of its own
            const client = new Inventory(`localhost:${port}`, grpc.credentials.createSsl(ca));
            const { error } = await unary(
              client,
              'GetItem',
              { id: 'w-1' },
              { deadline: Date.now() + 3000 }
            );
            client.close();
            expect(error).toBeTruthy();
          } finally {
            await mtlsApp.stopGrpc();
            await mtlsApp.close();
          }
        }
      });

      it('a MoroJS client with PEM credentials calls TLS servers', async () => {
        for (const port of [plainTlsPort, moroTlsPort]) {
          const client = await app.createGrpcClient(PROTO, 'Inventory', `localhost:${port}`, {
            credentials: { rootCerts: ca },
          });
          await expect(client.GetItem({ id: 'g-2' })).resolves.toEqual(gadget);
          client.close();
        }
      });

      it('a MoroJS client that does not trust the certificate is refused', async () => {
        const client = await app.createGrpcClient(PROTO, 'Inventory', `localhost:${plainTlsPort}`, {
          credentials: { rootCerts: Buffer.from(fixture('selfsigned.pem')) },
        });
        await expect(
          client.GetItem({ id: 'w-1' }, { deadline: Date.now() + 3000 })
        ).rejects.toMatchObject({ code: expect.any(Number) });
        client.close();
      });

      it('a MoroJS client without credentials cannot call a TLS server', async () => {
        const client = await app.createGrpcClient(PROTO, 'Inventory', `localhost:${plainTlsPort}`);
        await expect(
          client.GetItem({ id: 'w-1' }, { deadline: Date.now() + 3000 })
        ).rejects.toMatchObject({ code: expect.any(Number) });
        client.close();
      });
    });
  });
});
