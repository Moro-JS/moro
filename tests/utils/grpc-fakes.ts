// Stand-ins for @grpc/grpc-js and @grpc/proto-loader, shaped like the real
// packages, for unit tests that must run without them installed.
//
// The shapes that matter, and that these stand-ins keep:
//
// - protoLoader.load() resolves to a package definition: a flat map from
//   fully-qualified name ("acme.inventory.v1.Inventory") to a service (a map of
//   method name -> method definition) or to a message/enum type definition (an
//   object with a `format` string).
// - A method definition carries `path`, `requestStream`, `responseStream`,
//   `originalName` (the lower-camel-case name) and four serialisers that turn
//   messages into bytes and back. The bytes are not JSON, and a message of one
//   type cannot be read as another.
// - grpc.loadPackageDefinition() nests that map by package segment. In the
//   result a service is its client CONSTRUCTOR: a function with static
//   `service` (the method map) and `serviceName`, whose prototype has one
//   method per RPC under both its name and its `originalName`.
// - A unary client method takes (request, [metadata], [options], callback) and
//   throws "Incorrect arguments passed" without a callback.
//
// Calls travel over an in-memory "wire": the client serialises the request, the
// server bound at that address deserialises it with its own definition, and the
// response comes back the same way. A side that uses the wrong serialisers
// therefore cannot talk to a side generated from the .proto.

import { GrpcJsAdapter } from '../../src/core/grpc/adapters/grpc-js-adapter.js';
import { GrpcManager } from '../../src/core/grpc/grpc-manager.js';
import type { GrpcOptions } from '../../src/core/grpc/types.js';

type Serialize = (value: any) => Buffer;
type Deserialize = (bytes: Buffer) => any;

export interface FakeMethodDefinition {
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  originalName: string;
  requestType: FakeTypeDefinition;
  responseType: FakeTypeDefinition;
  requestSerialize: Serialize;
  requestDeserialize: Deserialize;
  responseSerialize: Serialize;
  responseDeserialize: Deserialize;
}

export interface FakeTypeDefinition {
  format: string;
  type: { name: string };
  fileDescriptorProtos: Buffer[];
}

export type FakeServiceDefinition = Record<string, FakeMethodDefinition>;
export type FakePackageDefinition = Record<string, FakeServiceDefinition | FakeTypeDefinition>;

/** One RPC of a service: message type names and streaming mode. */
export interface FakeMethodSpec {
  request?: string;
  response?: string;
  requestStream?: boolean;
  responseStream?: boolean;
}

/** `{ 'acme.inventory.v1': { Inventory: { GetItem: {}, ListItems: { responseStream: true } } } }` */
export type FakeProtoSpec = Record<string, Record<string, Record<string, FakeMethodSpec>>>;

const MAGIC = 0xfa;

/**
 * A binary codec for one message type. Encoded messages start with a magic
 * byte and the type name; decoding bytes that are not a message of this type
 * (JSON text, or another type) throws, as a protobuf decoder would.
 */
function codecFor(typeName: string): { serialize: Serialize; deserialize: Deserialize } {
  const header = Buffer.concat([Buffer.from([MAGIC, typeName.length]), Buffer.from(typeName)]);
  return {
    serialize: value => {
      if (value === null || typeof value !== 'object') {
        throw new Error(`${typeName}: cannot serialize ${typeof value}`);
      }
      const body = Buffer.from(JSON.stringify(value)).map(byte => byte ^ 0x5a);
      return Buffer.concat([header, body]);
    },
    deserialize: bytes => {
      if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, header.length).equals(header)) {
        throw new Error(`Error deserializing ${typeName}: invalid wire type`);
      }
      const body = Buffer.from(bytes.subarray(header.length)).map(byte => byte ^ 0x5a);
      return JSON.parse(body.toString());
    },
  };
}

function typeDefinition(name: string, kind = 'DescriptorProto'): FakeTypeDefinition {
  return { format: `Protocol Buffer 3 ${kind}`, type: { name }, fileDescriptorProtos: [] };
}

const lowerCamel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** The package definition protoLoader.load() would resolve to for these services. */
export function fakePackageDefinition(spec: FakeProtoSpec): FakePackageDefinition {
  const definition: FakePackageDefinition = {};

  for (const [packageName, services] of Object.entries(spec)) {
    const qualify = (name: string) => (packageName ? `${packageName}.${name}` : name);

    for (const [serviceName, methods] of Object.entries(services)) {
      const service: FakeServiceDefinition = {};

      for (const [methodName, method] of Object.entries(methods)) {
        const requestName = qualify(method.request ?? `${methodName}Request`);
        const responseName = qualify(method.response ?? `${methodName}Response`);
        const request = codecFor(requestName);
        const response = codecFor(responseName);
        definition[requestName] ??= typeDefinition(requestName);
        definition[responseName] ??= typeDefinition(responseName);

        service[methodName] = {
          path: `/${qualify(serviceName)}/${methodName}`,
          requestStream: method.requestStream ?? false,
          responseStream: method.responseStream ?? false,
          originalName: lowerCamel(methodName),
          requestType: definition[requestName] as FakeTypeDefinition,
          responseType: definition[responseName] as FakeTypeDefinition,
          requestSerialize: request.serialize,
          requestDeserialize: request.deserialize,
          responseSerialize: response.serialize,
          responseDeserialize: response.deserialize,
        };
      }

      definition[qualify(serviceName)] = service;
    }
  }

  return definition;
}

/** The package definition protoLoader.fromJSON() would return for a protobufjs JSON descriptor. */
function packageDefinitionFromJson(json: any): FakePackageDefinition {
  const definition: FakePackageDefinition = {};

  const walk = (node: any, prefix: string): void => {
    for (const [name, child] of Object.entries<any>(node?.nested ?? {})) {
      const qualified = prefix ? `${prefix}.${name}` : name;

      if (child.methods) {
        const service: FakeServiceDefinition = {};
        for (const [methodName, method] of Object.entries<any>(child.methods)) {
          const request = codecFor(`${prefix}.${method.requestType}`);
          const response = codecFor(`${prefix}.${method.responseType}`);
          service[methodName] = {
            path: `/${qualified}/${methodName}`,
            requestStream: method.requestStream ?? false,
            responseStream: method.responseStream ?? false,
            originalName: lowerCamel(methodName),
            requestType: typeDefinition(`${prefix}.${method.requestType}`),
            responseType: typeDefinition(`${prefix}.${method.responseType}`),
            requestSerialize: request.serialize,
            requestDeserialize: request.deserialize,
            responseSerialize: response.serialize,
            responseDeserialize: response.deserialize,
          };
        }
        definition[qualified] = service;
      } else if (child.fields) {
        definition[qualified] = typeDefinition(qualified);
        walk(child, qualified);
      } else if (child.values) {
        definition[qualified] = typeDefinition(qualified, 'EnumDescriptorProto');
      } else {
        walk(child, qualified);
      }
    }
  };

  walk(json, '');
  return definition;
}

/** A stand-in for @grpc/proto-loader serving the given files. */
export function fakeProtoLoader(files: Record<string, FakePackageDefinition>) {
  const loads: Array<{ path: string; options: unknown }> = [];
  const fromJsonResults: FakePackageDefinition[] = [];

  return {
    loads,
    fromJsonResults,
    load: async (path: string, options?: unknown): Promise<FakePackageDefinition> => {
      loads.push({ path, options });
      const definition = files[path];
      if (!definition) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
      }
      return definition;
    },
    fromJSON: (json: unknown): FakePackageDefinition => {
      const definition = packageDefinitionFromJson(json);
      fromJsonResults.push(definition);
      return definition;
    },
  };
}

export interface FakeChannelCredentials {
  kind: 'insecure' | 'ssl';
  pem: unknown[];
  _isSecure(): boolean;
}

/** A stand-in for @grpc/grpc-js. */
export function fakeGrpcJs() {
  const status = {
    OK: 0,
    CANCELLED: 1,
    UNKNOWN: 2,
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    NOT_FOUND: 5,
    ALREADY_EXISTS: 6,
    PERMISSION_DENIED: 7,
    RESOURCE_EXHAUSTED: 8,
    FAILED_PRECONDITION: 9,
    ABORTED: 10,
    OUT_OF_RANGE: 11,
    UNIMPLEMENTED: 12,
    INTERNAL: 13,
    UNAVAILABLE: 14,
    DATA_LOSS: 15,
    UNAUTHENTICATED: 16,
  };

  class Metadata {
    readonly values = new Map<string, Array<string | Buffer>>();
    get(key: string) {
      return this.values.get(key.toLowerCase()) ?? [];
    }
    set(key: string, value: string | Buffer) {
      this.values.set(key.toLowerCase(), [value]);
    }
    add(key: string, value: string | Buffer) {
      this.values.set(key.toLowerCase(), [...this.get(key), value]);
    }
    remove(key: string) {
      this.values.delete(key.toLowerCase());
    }
    getMap() {
      const map: Record<string, string | Buffer> = {};
      for (const [key, values] of this.values) {
        if (values[0] !== undefined) map[key] = values[0];
      }
      return map;
    }
  }

  class ChannelCredentials implements FakeChannelCredentials {
    constructor(
      readonly kind: 'insecure' | 'ssl',
      readonly pem: unknown[] = []
    ) {}
    _isSecure() {
      return this.kind === 'ssl';
    }
  }

  // address -> server listening there
  const listening = new Map<string, Server>();
  const servers: Server[] = [];
  const clients: any[] = [];

  class Server {
    registered: Array<{ definition: Record<string, any>; implementation: Record<string, any> }> =
      [];
    address?: string;
    credentials?: unknown;

    constructor(readonly options: Record<string, unknown> = {}) {
      servers.push(this);
    }

    addService(definition: Record<string, any>, implementation: Record<string, any>) {
      this.registered.push({ definition, implementation });
    }

    bindAsync(
      address: string,
      credentials: unknown,
      callback: (error: Error | null, port: number) => void
    ) {
      this.address = address;
      this.credentials = credentials;
      listening.set(address, this);
      callback(null, Number(address.split(':').pop()));
    }

    tryShutdown(callback: (error?: Error) => void) {
      if (this.address) listening.delete(this.address);
      callback();
    }

    forceShutdown() {
      if (this.address) listening.delete(this.address);
    }

    /** The handler for a path, found by method name or lower-camel-case name as grpc-js does. */
    handlerFor(path: string) {
      for (const { definition, implementation } of this.registered) {
        for (const [name, attrs] of Object.entries(definition)) {
          if (attrs.path !== path) continue;
          const handler = implementation[name] ?? implementation[attrs.originalName];
          return handler ? { attrs, handler: handler.bind(implementation) } : undefined;
        }
      }
      return undefined;
    }
  }

  /** One unary call over the in-memory wire. */
  function unaryCall(client: any, attrs: any, args: any[]) {
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') {
      throw new Error('Incorrect arguments passed');
    }
    const [request, ...rest] = args.slice(0, -1);
    const metadata = rest.find(arg => arg instanceof Metadata) ?? new Metadata();
    const fail = (code: number, details: string) =>
      callback(Object.assign(new Error(`${code}: ${details}`), { code, details }));

    let wireRequest: Buffer;
    try {
      wireRequest = attrs.requestSerialize(request);
    } catch (error) {
      queueMicrotask(() => fail(status.INTERNAL, `Request message serialization failure`));
      return { cancel() {} };
    }

    queueMicrotask(async () => {
      const server = listening.get(client.address);
      const target = server?.handlerFor(attrs.path);
      if (!server) return fail(status.UNAVAILABLE, 'No connection established');
      if (!target) return fail(status.UNIMPLEMENTED, `The server does not implement ${attrs.path}`);

      let serverRequest: unknown;
      try {
        serverRequest = target.attrs.requestDeserialize(wireRequest);
      } catch {
        return fail(status.INTERNAL, 'Error deserializing request');
      }

      const call = {
        request: serverRequest,
        metadata,
        cancelled: false,
        getPeer: () => 'in-memory',
        sendMetadata: () => undefined,
      };
      await target.handler(call, (error: any, response?: unknown) => {
        if (error) {
          return callback(
            Object.assign(new Error(`${error.code}: ${error.message}`), {
              code: typeof error.code === 'number' ? error.code : status.UNKNOWN,
              details: error.details ?? error.message,
              metadata: error.metadata ?? new Metadata(),
            })
          );
        }
        let wireResponse: Buffer;
        try {
          wireResponse = target.attrs.responseSerialize(response);
        } catch {
          return fail(status.INTERNAL, 'Error serializing response');
        }
        try {
          callback(null, attrs.responseDeserialize(wireResponse));
        } catch {
          fail(status.INTERNAL, 'Response message parsing error');
        }
      });
    });

    return { cancel() {} };
  }

  function makeGenericClientConstructor(methods: Record<string, any>, serviceName: string) {
    class ServiceClient {
      constructor(
        readonly address: string,
        readonly credentials: unknown,
        readonly options: Record<string, unknown> = {}
      ) {
        clients.push(this);
      }
      close() {}
    }
    const prototype = ServiceClient.prototype as any;

    for (const [name, attrs] of Object.entries(methods)) {
      const unary = !attrs.requestStream && !attrs.responseStream;
      const method = function (this: ServiceClient, ...args: any[]) {
        if (unary) return unaryCall(this, attrs, args);
        // Streaming calls are not carried by the in-memory wire
        return { on() {}, write() {}, end() {}, cancel() {} };
      };
      // grpc-js keeps the method's attributes on the function
      Object.assign(method, attrs);
      prototype[name] = method;
      if (attrs.originalName) prototype[attrs.originalName] = prototype[name];
    }

    return Object.assign(ServiceClient, { service: methods, serviceName });
  }

  function loadPackageDefinition(packageDefinition: FakePackageDefinition) {
    const root: Record<string, any> = {};

    for (const [qualifiedName, entry] of Object.entries(packageDefinition)) {
      const segments = qualifiedName.split('.');
      const name = segments.pop() as string;
      let namespace = root;
      for (const segment of segments) {
        namespace = namespace[segment] ??= {};
      }
      namespace[name] =
        'format' in entry
          ? Object.assign(namespace[name] ?? {}, entry)
          : makeGenericClientConstructor(entry, name);
    }

    return root;
  }

  return {
    status,
    Metadata,
    Server,
    ChannelCredentials,
    credentials: {
      createInsecure: () => new ChannelCredentials('insecure'),
      createSsl: (...pem: unknown[]) => new ChannelCredentials('ssl', pem),
    },
    ServerCredentials: {
      createInsecure: () => ({ kind: 'insecure' }),
      createSsl: (...args: unknown[]) => ({ kind: 'ssl', args }),
    },
    loadPackageDefinition,
    makeGenericClientConstructor,
    servers,
    clients,
  };
}

/**
 * A GrpcJsAdapter that runs on the stand-ins: `initialize()` does what the real
 * one does once it has imported the two packages.
 */
export function adapterOnFakes(files: Record<string, FakePackageDefinition>) {
  const grpc = fakeGrpcJs();
  const loader = fakeProtoLoader(files);
  const adapter = new GrpcJsAdapter();
  const internals = adapter as unknown as {
    options: GrpcOptions;
    grpcJs: unknown;
    protoLoader: unknown;
    server: InstanceType<typeof grpc.Server>;
  };

  adapter.initialize = async (options: GrpcOptions) => {
    internals.options = { ...options };
    internals.grpcJs = grpc;
    internals.protoLoader = loader;
    internals.server = new grpc.Server();
  };

  return {
    adapter,
    grpc,
    loader,
    /** The grpc-js server the adapter registers services on */
    server: () => internals.server,
  };
}

/** A GrpcManager whose grpc-js adapter runs on the stand-ins. */
export function managerOnFakes(
  files: Record<string, FakePackageDefinition>,
  options: GrpcOptions = {}
) {
  const fakes = adapterOnFakes(files);
  const manager = new GrpcManager(options);
  (manager as unknown as { loadGrpcJsAdapter: () => Promise<void> }).loadGrpcJsAdapter =
    async () => {
      (manager as unknown as { adapter: GrpcJsAdapter }).adapter = fakes.adapter;
    };
  return { manager, ...fakes };
}
