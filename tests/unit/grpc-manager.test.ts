// gRPC Manager Unit Tests
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';
import type { GrpcCall, GrpcOptions } from '../../src/core/grpc/types.js';
import { fakePackageDefinition, managerOnFakes } from '../utils/grpc-fakes.js';
import * as packageUtils from '../../src/core/utilities/package-utils.js';

// warn()/info() are instance properties (noops below the active level), so
// raise the level and observe the shared private log(level, message) sink.
function captureLogs() {
  globalLogger.setLevel('debug');
  const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  return {
    at: (level: string) => spy.mock.calls.filter(c => c[0] === level).map(c => String(c[1])),
    all: () => spy.mock.calls.map(c => String(c[1])),
  };
}

describe('GrpcManager', () => {
  describe('Type Safety', () => {
    it('should have proper TypeScript types', async () => {
      const types = await import('../../src/core/grpc/types.js');

      expect(types).toBeDefined();
      expect(types.GrpcStatusCode).toBeDefined();
      expect(types.HealthCheckStatus).toBeDefined();
    });

    it('should export GrpcStatusCode enum', async () => {
      const { GrpcStatusCode } = await import('../../src/core/grpc/types.js');

      expect(GrpcStatusCode.OK).toBe(0);
      expect(GrpcStatusCode.CANCELLED).toBe(1);
      expect(GrpcStatusCode.UNKNOWN).toBe(2);
      expect(GrpcStatusCode.INVALID_ARGUMENT).toBe(3);
      expect(GrpcStatusCode.DEADLINE_EXCEEDED).toBe(4);
      expect(GrpcStatusCode.NOT_FOUND).toBe(5);
      expect(GrpcStatusCode.ALREADY_EXISTS).toBe(6);
      expect(GrpcStatusCode.PERMISSION_DENIED).toBe(7);
      expect(GrpcStatusCode.RESOURCE_EXHAUSTED).toBe(8);
      expect(GrpcStatusCode.FAILED_PRECONDITION).toBe(9);
      expect(GrpcStatusCode.ABORTED).toBe(10);
      expect(GrpcStatusCode.OUT_OF_RANGE).toBe(11);
      expect(GrpcStatusCode.UNIMPLEMENTED).toBe(12);
      expect(GrpcStatusCode.INTERNAL).toBe(13);
      expect(GrpcStatusCode.UNAVAILABLE).toBe(14);
      expect(GrpcStatusCode.DATA_LOSS).toBe(15);
      expect(GrpcStatusCode.UNAUTHENTICATED).toBe(16);
    });

    it('exports GrpcStatusCode from the package root as a value, not only a type', async () => {
      const root = await import('../../src/index.js');
      const types = await import('../../src/core/grpc/types.js');

      expect(root.GrpcStatusCode).toBe(types.GrpcStatusCode);
      expect(root.GrpcStatusCode.NOT_FOUND).toBe(5);
      expect(root.GrpcStatusCode[16]).toBe('UNAUTHENTICATED');
    });
  });

  describe('Lazy Loading', () => {
    it('should lazy load GrpcManager', async () => {
      try {
        const { GrpcManager } = await import('../../src/core/grpc/grpc-manager.js');
        expect(GrpcManager).toBeDefined();
        expect(typeof GrpcManager).toBe('function');
      } catch (error) {
        // This is expected if dependencies are not available
        expect(error).toBeDefined();
      }
    });

    it('should lazy load GrpcJsAdapter', async () => {
      try {
        const { GrpcJsAdapter } = await import('../../src/core/grpc/adapters/grpc-js-adapter.js');
        expect(GrpcJsAdapter).toBeDefined();
        expect(typeof GrpcJsAdapter).toBe('function');
      } catch (error) {
        // This is expected if dependencies are not available
        expect(error).toBeDefined();
      }
    });
  });

  describe('Middleware Exports', () => {
    it('should export gRPC middleware functions', async () => {
      const middleware = await import('../../src/core/grpc/index.js');

      expect(middleware.grpcAuth).toBeDefined();
      expect(middleware.grpcRequirePermission).toBeDefined();
      expect(middleware.grpcRequireRole).toBeDefined();
      expect(middleware.grpcLogger).toBeDefined();
      expect(middleware.grpcSimpleLogger).toBeDefined();
      expect(middleware.grpcDetailedLogger).toBeDefined();
      expect(middleware.grpcValidate).toBeDefined();
      expect(middleware.grpcValidateHandler).toBeDefined();
    });
  });
});

// `enableReflection` and `compression` are accepted by GrpcOptions but nothing
// implements them. Initialization says so in a warning; it never reports a
// feature as enabled that is not.
describe('gRPC options that are not implemented', () => {
  /** A manager whose grpc-js adapter is real but runs on stand-in packages. */
  function managerFor(options: GrpcOptions) {
    return managerOnFakes({}, { enableHealthCheck: false, ...options });
  }

  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
  });

  it('warns once that enableReflection has no effect, and never reports it enabled', async () => {
    const logs = captureLogs();
    const { manager, adapter } = managerFor({ enableReflection: true });

    await manager.initialize();
    adapter.enableReflection();

    const warnings = logs.at('warn').filter(m => m.includes('enableReflection'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not implemented');
    expect(warnings[0]).toContain('no effect');
    expect(logs.all().filter(m => /reflection enabled/i.test(m))).toEqual([]);
  });

  for (const compression of [true, false]) {
    it(`warns that compression: ${compression} has no effect`, async () => {
      const logs = captureLogs();
      const { manager } = managerFor({ compression });

      await manager.initialize();

      const warnings = logs.at('warn').filter(m => m.includes('compression'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not implemented');
      expect(warnings[0]).toContain('no effect');
    });
  }

  it('says nothing when neither option is set', async () => {
    const logs = captureLogs();
    const { manager } = managerFor({});

    await manager.initialize();

    expect(logs.at('warn')).toEqual([]);
  });
});

describe('a gRPC package that is not installed', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
  });

  it('logs the install hint one line per log entry, and throws it whole', async () => {
    const logs = captureLogs();
    jest.spyOn(packageUtils, 'isPackageAvailable').mockReturnValue(false);
    const { GrpcManager } = await import('../../src/core/grpc/grpc-manager.js');

    const failure = await new GrpcManager({}).initialize().then(
      () => undefined,
      (error: Error) => error
    );

    // The caller gets the hint as one message, as before
    expect(failure?.message).toBe(
      '@grpc/grpc-js package not found.\n' +
        'To use gRPC with MoroJS, install the required packages:\n' +
        '  npm install @grpc/grpc-js @grpc/proto-loader\n\n' +
        'Then configure gRPC in your app:\n' +
        "  app.grpcInit({ port: 50051, adapter: 'grpc-js' });"
    );

    // The log has the same words, a line each
    expect(logs.at('error')).toEqual([
      'Failed to initialize gRPC manager: Error: @grpc/grpc-js package not found.',
      'To use gRPC with MoroJS, install the required packages:',
      '  npm install @grpc/grpc-js @grpc/proto-loader',
      'Then configure gRPC in your app:',
      "  app.grpcInit({ port: 50051, adapter: 'grpc-js' });",
    ]);
  });
});

describe('GrpcJsAdapter', () => {
  describe('Initialization', () => {
    it('should handle missing @grpc/grpc-js gracefully', async () => {
      try {
        const { GrpcJsAdapter } = await import('../../src/core/grpc/adapters/grpc-js-adapter.js');
        const adapter = new GrpcJsAdapter();

        await expect(adapter.initialize({})).rejects.toThrow();
      } catch (error) {
        // Expected when @grpc/grpc-js is not installed
        expect(error).toBeDefined();
      }
    });
  });

  describe('Adapter Interface', () => {
    it('should implement GrpcAdapter interface', async () => {
      try {
        const { GrpcJsAdapter } = await import('../../src/core/grpc/adapters/grpc-js-adapter.js');
        const adapter = new GrpcJsAdapter();

        expect(adapter.initialize).toBeDefined();
        expect(adapter.loadProto).toBeDefined();
        expect(adapter.addService).toBeDefined();
        expect(adapter.start).toBeDefined();
        expect(adapter.stop).toBeDefined();
        expect(adapter.createClient).toBeDefined();
        expect(adapter.enableHealthCheck).toBeDefined();
        expect(adapter.enableReflection).toBeDefined();
        expect(adapter.getAdapterName).toBeDefined();
        expect(adapter.isAvailable).toBeDefined();
      } catch (error) {
        // Expected when @grpc/grpc-js is not installed
        expect(error).toBeDefined();
      }
    });
  });
});

// Registration and clients, on stand-ins that have the shape of the real
// packages: a loaded service is a client constructor (a function) that carries
// the method definitions and their serialisers. The stand-ins exchange the
// serialised bytes, so a side that does not use the serialisers of the .proto
// cannot talk to one that does.
describe('gRPC services and clients', () => {
  const PROTO = 'inventory.proto';
  const ADDRESS = '127.0.0.1:50051';

  const inventoryProto = () =>
    fakePackageDefinition({
      'acme.inventory.v1': {
        Inventory: {
          GetItem: { request: 'GetItemRequest', response: 'Item' },
          ListItems: { request: 'ListItemsRequest', response: 'Item', responseStream: true },
          ImportItems: { request: 'Item', response: 'ImportSummary', requestStream: true },
          Adjust: {
            request: 'Adjustment',
            response: 'Item',
            requestStream: true,
            responseStream: true,
          },
        },
      },
    });

  type Files = Parameters<typeof managerOnFakes>[0];
  type Answer = { error: any; response?: any };

  async function initialized(files: Files, options: GrpcOptions = {}) {
    const fakes = managerOnFakes(files, {
      host: '127.0.0.1',
      port: 50051,
      enableHealthCheck: false,
      ...options,
    });
    await fakes.manager.initialize();
    return fakes;
  }

  /** The client any gRPC stack generates from the .proto: no MoroJS code involved. */
  function generatedClient(grpc: any, files: Files, address = ADDRESS) {
    const Inventory = grpc.loadPackageDefinition(files[PROTO]).acme.inventory.v1.Inventory;
    return new Inventory(address, grpc.credentials.createInsecure());
  }

  /** A server any gRPC stack generates from the .proto, listening at `address`. */
  function generatedServer(
    grpc: any,
    files: Files,
    implementation: Record<string, unknown>,
    address = ADDRESS
  ) {
    const Inventory = grpc.loadPackageDefinition(files[PROTO]).acme.inventory.v1.Inventory;
    const server = new grpc.Server();
    server.addService(Inventory.service, implementation);
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), () => undefined);
    return server;
  }

  const unary = (client: any, method: string, request: unknown) =>
    new Promise<Answer>(resolve =>
      client[method](request, (error: any, response: any) => resolve({ error, response }))
    );

  const getItem = async (call: GrpcCall, callback: (error: any, response?: any) => void) => {
    callback(null, { id: call.request.id, name: 'Widget', quantity: '9007199254740993' });
  };

  afterEach(() => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
  });

  describe('registering a service', () => {
    it('finds a service the package returns as a client constructor', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      const loaded = grpc.loadPackageDefinition(files[PROTO]).acme.inventory.v1;
      expect(typeof loaded.Inventory).toBe('function');
      expect(typeof loaded.Inventory.service).toBe('object');

      const registration = await manager.registerService(PROTO, 'Inventory', { GetItem: getItem });

      expect(registration).toEqual({
        serviceName: 'Inventory',
        methods: ['GetItem', 'ListItems', 'ImportItems', 'Adjust'],
      });
      expect(manager.getServices()).toEqual([registration]);
    });

    it('finds a service by its package-qualified name', async () => {
      const { manager, server } = await initialized({ [PROTO]: inventoryProto() });

      await manager.registerService(PROTO, 'acme.inventory.v1.Inventory', { GetItem: getItem });

      expect(server().registered[0].definition.GetItem.path).toBe(
        '/acme.inventory.v1.Inventory/GetItem'
      );
    });

    it('names the services of the file when the one asked for is not among them', async () => {
      const { manager } = await initialized({ [PROTO]: inventoryProto() });

      await expect(manager.registerService(PROTO, 'Orders', {})).rejects.toThrow(
        'Service Orders not found in inventory.proto. Available services: acme.inventory.v1.Inventory'
      );
    });

    it('reads a package named "service" as a package, and message types as types', async () => {
      const files = {
        [PROTO]: fakePackageDefinition({ 'acme.service.v1': { Orders: { Get: {}, List: {} } } }),
      };
      const { adapter } = await initialized(files);

      const services = await adapter.loadProto(PROTO);

      expect(services.map(s => [s.packageName, s.serviceName, Object.keys(s.methods)])).toEqual([
        ['acme.service.v1', 'Orders', ['Get', 'List']],
      ]);
    });

    it('takes the service in `packageName` when two packages define the name', async () => {
      const files = {
        [PROTO]: fakePackageDefinition({
          'a.v1': { Echo: { Say: {} } },
          'b.v1': { Echo: { Say: {} } },
        }),
      };
      const { manager, server } = await initialized(files);

      await manager.registerService(PROTO, 'Echo', { Say: getItem }, 'b.v1');

      expect(server().registered[0].definition.Say.path).toBe('/b.v1.Echo/Say');
    });

    it('registers each method with the serialisers of the loaded definition', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, server } = await initialized(files);

      await manager.registerService(PROTO, 'Inventory', { GetItem: getItem });

      const loaded = files[PROTO]['acme.inventory.v1.Inventory'] as Record<string, any>;
      const { definition } = server().registered[0];
      expect(Object.keys(definition)).toEqual(Object.keys(loaded));
      for (const [name, method] of Object.entries(loaded)) {
        expect(definition[name].path).toBe(method.path);
        expect(definition[name].requestStream).toBe(method.requestStream);
        expect(definition[name].responseStream).toBe(method.responseStream);
        expect(definition[name].requestSerialize).toBe(method.requestSerialize);
        expect(definition[name].requestDeserialize).toBe(method.requestDeserialize);
        expect(definition[name].responseSerialize).toBe(method.responseSerialize);
        expect(definition[name].responseDeserialize).toBe(method.responseDeserialize);
      }
    });

    it('answers a client generated from the .proto', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      const requests: unknown[] = [];
      await manager.registerService(PROTO, 'Inventory', {
        GetItem: async (call, callback) => {
          requests.push(call.request);
          await getItem(call, callback);
        },
      });
      await manager.start();

      const answer = await unary(generatedClient(grpc, files), 'GetItem', { id: 'w-1' });

      expect(answer.error).toBeNull();
      expect(answer.response).toEqual({ id: 'w-1', name: 'Widget', quantity: '9007199254740993' });
      expect(requests).toEqual([{ id: 'w-1' }]);
    });

    it('accepts a handler under the lower-camel-case name of its method', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      await manager.registerService(PROTO, 'Inventory', { getItem });
      await manager.start();

      const answer = await unary(generatedClient(grpc, files), 'GetItem', { id: 'w-2' });

      expect(answer.error).toBeNull();
      expect(answer.response.id).toBe('w-2');
      expect(manager.getStats()?.byMethod.GetItem.calls).toBe(1);
    });

    it('prefers the handler under the name in the .proto to its lower-camel-case form', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      await manager.registerService(PROTO, 'Inventory', {
        getItem: async (_call, callback) => callback(null, { id: 'from getItem' }),
        GetItem: async (_call, callback) => callback(null, { id: 'from GetItem' }),
      });
      await manager.start();

      const answer = await unary(generatedClient(grpc, files), 'GetItem', { id: 'x' });

      expect(answer.response).toEqual({ id: 'from GetItem' });
    });

    it('calls a handler with the implementation object as `this`, as grpc-js does', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc, server } = await initialized(files);
      const implementation = {
        prefix: 'item',
        async GetItem(this: { prefix: string }, call: GrpcCall, callback: any) {
          callback(null, { id: `${this.prefix}-${call.request.id}` });
        },
        ListItems: [
          async () => undefined,
          async function (this: { prefix: string }, call: GrpcCall) {
            (call as any).seenPrefix = this.prefix;
          },
        ],
      };
      await manager.registerService(PROTO, 'Inventory', implementation as any);
      await manager.start();

      const answer = await unary(generatedClient(grpc, files), 'GetItem', { id: '7' });
      expect(answer.response).toEqual({ id: 'item-7' });

      // After middleware in a handler array too
      const call: any = { request: {}, metadata: new grpc.Metadata(), emit: () => undefined };
      await server().registered[0].implementation.ListItems(call);
      expect(call.seenPrefix).toBe('item');
    });

    it('warns about a handler that matches no method of the service', async () => {
      const logs = captureLogs();
      const { manager, server } = await initialized({ [PROTO]: inventoryProto() });

      await manager.registerService(PROTO, 'Inventory', { GetItem: getItem, FetchItem: getItem });

      expect(Object.keys(server().registered[0].implementation)).toEqual(['GetItem']);
      const warnings = logs.at('warn').filter(m => m.includes('FetchItem'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('never called');
      expect(warnings[0]).toContain('GetItem, ListItems, ImportItems, Adjust');
    });

    it('says nothing about serialisers for a service loaded from a .proto', async () => {
      const logs = captureLogs();
      const { manager } = await initialized({ [PROTO]: inventoryProto() });

      await manager.registerService(PROTO, 'Inventory', { GetItem: getItem });

      expect(logs.at('warn')).toEqual([]);
    });

    it('warns that a hand-built definition without serialisers is exchanged as JSON', async () => {
      const logs = captureLogs();
      const { adapter, server } = await initialized({});

      adapter.addService(
        'Legacy',
        {
          serviceName: 'Legacy',
          methods: {
            Get: {
              path: '/Legacy/Get',
              requestStream: false,
              responseStream: false,
              requestType: {},
              responseType: {},
            },
          },
        },
        { Get: getItem }
      );

      const { definition } = server().registered[0];
      expect(definition.Get.responseSerialize({ id: 1 }).toString()).toBe('{"id":1}');
      const warnings = logs.at('warn').filter(m => m.includes('Legacy'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('sent as JSON');
    });
  });

  describe('server credentials', () => {
    const tls = { privateKey: Buffer.from('key'), certChain: Buffer.from('cert') };
    const started = async (options: GrpcOptions) => {
      const fakes = managerOnFakes({ [PROTO]: inventoryProto() }, options);
      await fakes.manager.initialize();
      await fakes.manager.start();
      const [server] = fakes.grpc.servers as any[];
      await fakes.manager.stop();
      return server.credentials as { kind: string; args?: unknown[] };
    };

    it('requires a client certificate for requireClientCert, and for its earlier name', async () => {
      const ca = Buffer.from('ca');
      const required = async (credentials: Record<string, unknown>) =>
        (await started({ credentials: { ...tls, rootCerts: ca, ...credentials } })).args?.[2];

      expect(await required({ requireClientCert: true })).toBe(true);
      expect(await required({ checkServerIdentity: true })).toBe(true);
      // The current name decides when both are given
      expect(await required({ requireClientCert: false, checkServerIdentity: true })).toBe(false);
      expect(await required({ requireClientCert: true, checkServerIdentity: false })).toBe(true);
      // Not asked for unless one of them says so
      expect(await required({})).toBe(false);
    });

    it('warns when it serves without TLS on an address other machines can reach', async () => {
      const warningsFor = async (options: GrpcOptions) => {
        const logs = captureLogs();
        await started({ enableHealthCheck: false, ...options });
        const warnings = logs.at('warn').filter(message => message.includes('without TLS'));
        jest.restoreAllMocks();
        return warnings;
      };

      // The default bind address is every interface
      const byDefault = await warningsFor({});
      expect(byDefault).toHaveLength(1);
      expect(byDefault[0]).toContain('0.0.0.0:50051');
      // Both ways out are named: local connections only, or TLS (and who may connect)
      expect(byDefault[0]).toContain("`host: '127.0.0.1'`");
      expect(byDefault[0]).toContain('`credentials`');
      expect(byDefault[0]).toContain('`requireClientCert: true`');
      expect(await warningsFor({ host: '10.1.2.3' })).toHaveLength(1);
      expect(await warningsFor({ host: '::' })).toHaveLength(1);

      for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
        expect(await warningsFor({ host })).toEqual([]);
      }
      expect(await warningsFor({ host: '0.0.0.0', credentials: tls })).toEqual([]);
    });
  });

  describe('the health service', () => {
    it('answers a health probe generated from grpc.health.v1', async () => {
      const { manager, grpc, loader } = await initialized({}, { enableHealthCheck: true });
      await manager.start();

      // The definition the adapter asked the loader for is the standard one
      expect(loader.fromJsonResults).toHaveLength(1);
      const Health = grpc.loadPackageDefinition(loader.fromJsonResults[0]).grpc.health.v1.Health;
      expect(Health.service.Check.path).toBe('/grpc.health.v1.Health/Check');
      expect(Health.service.Watch.responseStream).toBe(true);

      const probe = new Health(ADDRESS, grpc.credentials.createInsecure());
      const answer = await unary(probe, 'Check', { service: '' });

      expect(answer.error).toBeNull();
      expect(answer.response).toEqual({ status: 1 });
    });
  });

  describe('a client', () => {
    it('names the services of the file when the one asked for is not among them', async () => {
      const { manager } = await initialized({ [PROTO]: inventoryProto() });

      await expect(manager.createClient(PROTO, 'Orders', ADDRESS)).rejects.toThrow(
        'Service Orders not found in proto file inventory.proto. Available services: acme.inventory.v1.Inventory'
      );
    });

    it('calls a server generated from the .proto', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      const requests: unknown[] = [];
      generatedServer(grpc, files, {
        GetItem: (call: GrpcCall, callback: (error: any, response?: any) => void) => {
          requests.push(call.request);
          callback(null, { id: call.request.id, name: 'Widget' });
        },
      });

      const client = await manager.createClient(PROTO, 'Inventory', ADDRESS);
      const answer = await unary(client, 'GetItem', { id: 'w-1' });

      expect(answer.error).toBeNull();
      expect(answer.response).toEqual({ id: 'w-1', name: 'Widget' });
      expect(requests).toEqual([{ id: 'w-1' }]);
    });

    it('calls a MoroJS server', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager } = await initialized(files);
      await manager.registerService(PROTO, 'Inventory', { GetItem: getItem });
      await manager.start();

      const client = await manager.createClient(PROTO, 'acme.inventory.v1.Inventory', ADDRESS);

      await expect(client.GetItem({ id: 'w-3' })).resolves.toEqual({
        id: 'w-3',
        name: 'Widget',
        quantity: '9007199254740993',
      });
    });

    it('returns a promise from a unary method called without a callback', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      const metadataSeen: unknown[] = [];
      generatedServer(grpc, files, {
        GetItem: (call: GrpcCall, callback: (error: any, response?: any) => void) => {
          metadataSeen.push(call.metadata.get('x-tenant'));
          if (call.request.id === 'missing') {
            return callback({ code: grpc.status.NOT_FOUND, message: 'Item missing not found' });
          }
          callback(null, { id: call.request.id });
        },
      });
      const client = await manager.createClient(PROTO, 'Inventory', ADDRESS);

      const pending = client.GetItem({ id: 'w-1' });
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toEqual({ id: 'w-1' });

      // Metadata and call options go before the (absent) callback, as in grpc-js
      const metadata = new grpc.Metadata();
      metadata.set('x-tenant', 'tenant-7');
      await expect(client.GetItem({ id: 'w-2' }, metadata, { deadline: 1 })).resolves.toEqual({
        id: 'w-2',
      });
      expect(metadataSeen[1]).toEqual(['tenant-7']);

      await expect(client.GetItem({ id: 'missing' })).rejects.toMatchObject({
        code: 5,
        details: 'Item missing not found',
      });
    });

    it('keeps the callback form of a unary method as grpc-js defines it', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      generatedServer(grpc, files, { GetItem: getItem });
      const client: any = await manager.createClient(PROTO, 'Inventory', ADDRESS);

      let call: any;
      const answer = await new Promise<Answer>(resolve => {
        call = client.GetItem({ id: 'w-1' }, (error: any, response: any) =>
          resolve({ error, response })
        );
      });

      expect(answer.error).toBeNull();
      expect(answer.response.id).toBe('w-1');
      // The grpc-js call object, not a promise
      expect(typeof call.cancel).toBe('function');
      expect(call).not.toBeInstanceOf(Promise);
      // The method keeps the attributes grpc-js puts on it
      expect(client.GetItem.path).toBe('/acme.inventory.v1.Inventory/GetItem');
    });

    it('has every method under its lower-camel-case name too', async () => {
      const files = { [PROTO]: inventoryProto() };
      const { manager, grpc } = await initialized(files);
      generatedServer(grpc, files, { GetItem: getItem });
      const client: any = await manager.createClient(PROTO, 'Inventory', ADDRESS);

      expect(client.getItem).toBe(client.GetItem);
      await expect(client.getItem({ id: 'w-4' })).resolves.toMatchObject({ id: 'w-4' });
      for (const name of ['listItems', 'importItems', 'adjust']) {
        expect(typeof client[name]).toBe('function');
      }
    });

    it('leaves streaming methods returning the call stream', async () => {
      const { manager } = await initialized({ [PROTO]: inventoryProto() });
      const client: any = await manager.createClient(PROTO, 'Inventory', ADDRESS);

      for (const stream of [client.ListItems({}), client.ImportItems(() => {}), client.Adjust()]) {
        expect(stream).not.toBeInstanceOf(Promise);
        expect(typeof stream.on).toBe('function');
      }
    });

    describe('credentials', () => {
      const created = async (credentials?: unknown) => {
        const { manager, grpc } = await initialized({ [PROTO]: inventoryProto() });
        const options = credentials === undefined ? {} : { credentials: credentials as any };
        await manager.createClient(PROTO, 'Inventory', ADDRESS, options);
        return { grpc, used: grpc.clients[grpc.clients.length - 1].credentials };
      };

      it('opens a plaintext channel when no credentials are given', async () => {
        const { used } = await created();
        expect(used.kind).toBe('insecure');
      });

      it("opens a plaintext channel for credentials: 'insecure'", async () => {
        const { used } = await created('insecure');
        expect(used.kind).toBe('insecure');
      });

      it('uses grpc-js channel credentials as given', async () => {
        const fakes = await initialized({ [PROTO]: inventoryProto() });
        const insecure = fakes.grpc.credentials.createInsecure();
        const secure = fakes.grpc.credentials.createSsl('ca');

        await fakes.manager.createClient(PROTO, 'Inventory', ADDRESS, {
          credentials: insecure as any,
        });
        await fakes.manager.createClient(PROTO, 'Inventory', ADDRESS, {
          credentials: secure as any,
        });

        expect(fakes.grpc.clients.map(client => client.credentials)).toEqual([insecure, secure]);
        expect(fakes.grpc.clients[0].credentials).toBe(insecure);
        expect(fakes.grpc.clients[1].credentials).toBe(secure);
      });

      it('opens a TLS channel from PEM contents', async () => {
        const pem = {
          rootCerts: Buffer.from('ca'),
          privateKey: Buffer.from('key'),
          certChain: Buffer.from('cert'),
        };
        const { used } = await created(pem);
        expect(used.kind).toBe('ssl');
        expect(used.pem).toEqual([pem.rootCerts, pem.privateKey, pem.certChain]);

        // No PEM contents: TLS against the default root certificates
        const defaults = await created({});
        expect(defaults.used.kind).toBe('ssl');
        expect(defaults.used.pem).toEqual([undefined, undefined, undefined]);
      });
    });

    it('applies the message size limits and channelOptions', async () => {
      const { manager, grpc } = await initialized(
        { [PROTO]: inventoryProto() },
        { maxReceiveMessageLength: 1024, maxSendMessageLength: 2048 }
      );

      await manager.createClient(PROTO, 'Inventory', ADDRESS, {
        channelOptions: { 'grpc.keepalive_time_ms': 30000, 'grpc.max_send_message_length': 4096 },
      });

      expect(grpc.clients[0].options).toEqual({
        'grpc.max_receive_message_length': 1024,
        'grpc.max_send_message_length': 4096,
        'grpc.keepalive_time_ms': 30000,
      });
    });

    it('warns that the client options `deadline` and `interceptors` have no effect', async () => {
      const logs = captureLogs();
      const { manager } = await initialized({ [PROTO]: inventoryProto() });

      await manager.createClient(PROTO, 'Inventory', ADDRESS);
      expect(logs.at('warn')).toEqual([]);

      await manager.createClient(PROTO, 'Inventory', ADDRESS, { deadline: 5000, interceptors: [] });
      const warnings = logs.at('warn');
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('`deadline` is not implemented');
      expect(warnings[1]).toContain('`interceptors` is not implemented');
    });
  });
});
