// @grpc/grpc-js Adapter Implementation
// High-performance Node.js gRPC implementation

import { resolveUserPackage, isPackageAvailable } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { findServiceDefinition, qualifiedServiceName } from '../grpc-adapter.js';
import type { GrpcAdapter } from '../grpc-adapter.js';
import type {
  GrpcOptions,
  ServiceImplementation,
  GrpcServer,
  GrpcClient,
  GrpcClientOptions,
  GrpcCredentials,
  ServiceDefinition,
  MethodDefinition,
  ProtoLoadOptions,
  ServiceRegistration,
  GrpcCall,
  GrpcStats,
  HealthCheckResponse,
} from '../types.js';
import { GrpcStatusCode, HealthCheckStatus } from '../types.js';

// Lazy-loaded gRPC modules, shared by every adapter instance
let loadedGrpcJs: any = null;
let loadedProtoLoader: any = null;

/**
 * A CommonJS package imported from ESM: its exports are on the namespace when
 * Node can detect them statically, and always on `default`.
 */
function moduleExports(namespace: any, probe: string): any {
  return namespace && namespace[probe] === undefined && namespace.default
    ? namespace.default
    : namespace;
}

/**
 * grpc.health.v1 (the standard gRPC health checking protocol), as a protobufjs
 * JSON descriptor: the Health service is registered with the same protobuf
 * serialisers any health probe uses.
 */
const HEALTH_PROTO_DESCRIPTOR = {
  nested: {
    grpc: {
      nested: {
        health: {
          nested: {
            v1: {
              nested: {
                HealthCheckRequest: {
                  fields: { service: { type: 'string', id: 1 } },
                },
                HealthCheckResponse: {
                  fields: { status: { type: 'ServingStatus', id: 1 } },
                  nested: {
                    ServingStatus: {
                      values: { UNKNOWN: 0, SERVING: 1, NOT_SERVING: 2, SERVICE_UNKNOWN: 3 },
                    },
                  },
                },
                Health: {
                  methods: {
                    Check: {
                      requestType: 'HealthCheckRequest',
                      responseType: 'HealthCheckResponse',
                    },
                    Watch: {
                      requestType: 'HealthCheckRequest',
                      responseType: 'HealthCheckResponse',
                      responseStream: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// The encoding of a method whose definition carries no protobuf serialisers
/**
 * Whether a bind host only accepts connections from this machine:
 * `localhost`, an address in 127.0.0.0/8, or `::1` (with or without brackets).
 */
export function isLoopbackHost(host: string): boolean {
  const name = String(host)
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  return (
    name === 'localhost' ||
    name === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(name) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(name)
  );
}

const jsonSerialize = (value: any): Buffer => Buffer.from(JSON.stringify(value));
const jsonDeserialize = (buffer: Buffer): any => JSON.parse(buffer.toString());

/**
 * The gRPC status code an error carries, if it carries one: an integer `code`
 * from 1 (CANCELLED) to 16 (UNAUTHENTICATED). String codes such as Node's
 * 'ENOENT' and out-of-range numbers are not gRPC statuses.
 */
export function explicitGrpcStatus(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16
    ? code
    : undefined;
}

// What a client is told in production about an error the handler did not
// give a status to: the name of the status it was mapped to, nothing more
const GENERIC_STATUS_TEXT: Readonly<Record<number, string>> = {
  [GrpcStatusCode.INTERNAL]: 'Internal server error',
  [GrpcStatusCode.NOT_FOUND]: 'Not found',
  [GrpcStatusCode.UNAUTHENTICATED]: 'Unauthenticated',
  [GrpcStatusCode.PERMISSION_DENIED]: 'Permission denied',
  [GrpcStatusCode.INVALID_ARGUMENT]: 'Invalid argument',
};

/**
 * @grpc/grpc-js adapter for MoroJS
 * Provides full gRPC support for Node.js applications
 */
export class GrpcJsAdapter implements GrpcAdapter {
  private server: any; // grpc.Server instance
  // The @grpc/grpc-js and @grpc/proto-loader modules, set by initialize()
  private grpcJs: any = null;
  private protoLoader: any = null;
  private options: GrpcOptions = {};
  private logger = createFrameworkLogger('GRPC_JS');
  private serviceRegistrations = new Map<string, ServiceRegistration>();
  private stats: GrpcStats = {
    totalCalls: 0,
    activeCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    averageLatency: 0,
    byMethod: {},
  };
  private isStarted = false;
  private boundAddress: string = '';
  private reflectionWarned = false;

  async initialize(options: GrpcOptions): Promise<void> {
    this.options = { ...options };

    try {
      // Lazy load @grpc/grpc-js
      if (!loadedGrpcJs) {
        const grpcPath = resolveUserPackage('@grpc/grpc-js');
        loadedGrpcJs = moduleExports(await import(grpcPath), 'Server');
        this.logger.info('@grpc/grpc-js loaded successfully', 'Init');
      }
      this.grpcJs = loadedGrpcJs;

      // Lazy load @grpc/proto-loader
      if (!loadedProtoLoader) {
        const protoLoaderPath = resolveUserPackage('@grpc/proto-loader');
        loadedProtoLoader = moduleExports(await import(protoLoaderPath), 'load');
        this.logger.info('@grpc/proto-loader loaded successfully', 'Init');
      }
      this.protoLoader = loadedProtoLoader;

      // Create gRPC server with options
      const serverOptions: any = {};

      if (options.maxReceiveMessageLength) {
        serverOptions['grpc.max_receive_message_length'] = options.maxReceiveMessageLength;
      }
      if (options.maxSendMessageLength) {
        serverOptions['grpc.max_send_message_length'] = options.maxSendMessageLength;
      }
      if (options.maxConcurrentCalls) {
        serverOptions['grpc.max_concurrent_streams'] = options.maxConcurrentCalls;
      }
      if (options.keepaliveTimeMs) {
        serverOptions['grpc.keepalive_time_ms'] = options.keepaliveTimeMs;
      }
      if (options.keepaliveTimeoutMs) {
        serverOptions['grpc.keepalive_timeout_ms'] = options.keepaliveTimeoutMs;
      }
      if (options.keepalivePermitWithoutCalls !== undefined) {
        serverOptions['grpc.keepalive_permit_without_calls'] = options.keepalivePermitWithoutCalls
          ? 1
          : 0;
      }

      // Merge with custom channel options
      const channelOptions = { ...serverOptions, ...options.channelOptions };

      this.server = new this.grpcJs.Server(channelOptions);

      this.logger.info('gRPC server created', 'Init');
    } catch (error) {
      throw new Error(
        'Failed to load @grpc/grpc-js (optional dependency)\n' +
          'To use gRPC, install the required packages:\n' +
          '  npm install @grpc/grpc-js @grpc/proto-loader\n' +
          'Error: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  async loadProto(
    protoPath: string,
    packageName?: string,
    options?: ProtoLoadOptions
  ): Promise<ServiceDefinition[]> {
    if (!this.protoLoader || !this.grpcJs) {
      throw new Error('gRPC modules not initialized. Call initialize() first.');
    }

    try {
      const loadOptions = {
        keepCase: options?.keepCase ?? true,
        longs: options?.longs ?? String,
        enums: options?.enums ?? String,
        defaults: options?.defaults ?? true,
        oneofs: options?.oneofs ?? true,
        ...options,
      };

      // Load proto file
      const packageDefinition = await this.protoLoader.load(protoPath, loadOptions);
      const services = this.collectServices(
        this.grpcJs.loadPackageDefinition(packageDefinition),
        packageName
      );

      this.logger.info(
        `Loaded proto file: ${protoPath}, found ${services.length} service(s)`,
        'Proto'
      );

      return services;
    } catch (error) {
      this.logger.error(`Failed to load proto file ${protoPath}: ${error}`, 'Proto');
      throw error;
    }
  }

  /**
   * The services of a loaded package definition.
   *
   * grpc.loadPackageDefinition() returns nested namespaces (plain objects, one
   * level per package segment). In them a service is its client constructor: a
   * function whose `service` member maps each method to its path, streaming
   * mode and protobuf serialisers. Message and enum types are objects that
   * carry a `format` string; they hold no services.
   */
  private collectServices(descriptor: any, defaultPackage?: string): ServiceDefinition[] {
    const services: ServiceDefinition[] = [];

    const walk = (namespace: any, currentPackage: string): void => {
      if (!namespace || typeof namespace !== 'object') return;

      for (const [key, value] of Object.entries(namespace)) {
        if (!value) continue;

        if (typeof value === 'function') {
          const loaded = (value as any).service;
          if (!loaded || typeof loaded !== 'object') continue;

          const serviceDef: ServiceDefinition = {
            serviceName: key,
            packageName: currentPackage || defaultPackage,
            methods: {},
          };

          for (const [methodName, methodDef] of Object.entries(loaded)) {
            if (!methodDef || typeof methodDef !== 'object') continue;
            const method = methodDef as any;
            const definition: MethodDefinition = {
              path:
                method.path || `/${currentPackage ? currentPackage + '.' : ''}${key}/${methodName}`,
              requestStream: method.requestStream || false,
              responseStream: method.responseStream || false,
              requestType: method.requestType,
              responseType: method.responseType,
              originalName: method.originalName || methodName,
            };
            // The protobuf serialisers of the method, as the .proto defines them
            if (typeof method.requestSerialize === 'function') {
              definition.requestSerialize = method.requestSerialize;
            }
            if (typeof method.requestDeserialize === 'function') {
              definition.requestDeserialize = method.requestDeserialize;
            }
            if (typeof method.responseSerialize === 'function') {
              definition.responseSerialize = method.responseSerialize;
            }
            if (typeof method.responseDeserialize === 'function') {
              definition.responseDeserialize = method.responseDeserialize;
            }
            serviceDef.methods[methodName] = definition;
          }

          services.push(serviceDef);
        } else if (typeof value === 'object' && typeof (value as any).format !== 'string') {
          // A nested package
          walk(value, currentPackage ? `${currentPackage}.${key}` : key);
        }
      }
    };

    walk(descriptor, '');
    return services;
  }

  addService(
    serviceName: string,
    serviceDefinition: ServiceDefinition,
    implementation: ServiceImplementation
  ): ServiceRegistration {
    if (!this.server) {
      throw new Error('gRPC server not initialized. Call initialize() first.');
    }

    try {
      // Build service definition for grpc-js
      const grpcServiceDef: any = {};
      const methodNames: string[] = [];
      const jsonMethods: string[] = [];
      // A handler is registered under the method's name in the .proto (GetUser)
      // or, as with grpc-js itself, its lower-camel-case form (getUser)
      const methodByHandlerName = new Map<string, string>();

      for (const [methodName, methodDef] of Object.entries(serviceDefinition.methods)) {
        const wire = this.wireFormat(methodDef);
        if (!wire.protobuf) jsonMethods.push(methodName);
        grpcServiceDef[methodName] = wire.definition;

        methodNames.push(methodName);
        if (methodDef.originalName && !methodByHandlerName.has(methodDef.originalName)) {
          methodByHandlerName.set(methodDef.originalName, methodName);
        }
      }
      for (const methodName of methodNames) {
        methodByHandlerName.set(methodName, methodName);
      }

      if (jsonMethods.length > 0) {
        this.logger.warn(
          `Service ${serviceName}: no protobuf serialisers for ${jsonMethods.join(', ')} ` +
            '(the definition was not produced by loadProto()). Messages of these methods are ' +
            'sent as JSON, which other gRPC clients and servers cannot read.',
          'Service'
        );
      }

      // Wrap implementation handlers with stats tracking
      const wrappedImplementation: any = {};
      const unknownHandlers: string[] = [];

      for (const [handlerName, handler] of Object.entries(implementation)) {
        const methodName = methodByHandlerName.get(handlerName);
        const methodDef = methodName ? serviceDefinition.methods[methodName] : undefined;
        if (!methodName || !methodDef) {
          unknownHandlers.push(handlerName);
          continue;
        }
        // The name in the .proto wins over its lower-camel-case form
        if (
          handlerName !== methodName &&
          Object.prototype.hasOwnProperty.call(implementation, methodName)
        ) {
          continue;
        }

        // Handle middleware array: every element before the last is a
        // middleware, the last element is the handler
        const handlers = Array.isArray(handler) ? handler : [handler];
        // The handler runs with the implementation object as `this`, as in grpc-js
        const finalHandler = handlers[handlers.length - 1];
        if (!finalHandler) continue;
        const middlewares = handlers.slice(0, -1);

        wrappedImplementation[methodName] = async (call: any, callback?: any) => {
          const startTime = Date.now();
          this.stats.totalCalls++;
          this.stats.activeCalls++;

          if (!this.stats.byMethod[methodName]) {
            this.stats.byMethod[methodName] = {
              calls: 0,
              errors: 0,
              averageLatency: 0,
            };
          }
          this.stats.byMethod[methodName].calls++;

          try {
            // Run the middleware in order, then the handler. A middleware stops
            // the chain by throwing, or by answering the call through the
            // callback. One that wraps the rest of the call (a logger, a timer)
            // receives `next` as its third argument and awaits it; passing a
            // callback to next(call, callback) lets it observe the response.
            if (middlewares.length > 0) {
              // Lets a logging middleware name the method it is reporting on
              if (call && call.methodPath === undefined) {
                call.methodPath = methodDef.path;
              }

              let answered = false;
              let answeredWithError = false;
              let handlerRan = false;
              const chainCallback = callback
                ? (...args: any[]) => {
                    answered = true;
                    answeredWithError = !!args[0];
                    return callback(...args);
                  }
                : undefined;

              const runFrom = async (index: number, current: any): Promise<void> => {
                for (let i = index; i < middlewares.length; i++) {
                  if (answered) return;
                  const middleware = middlewares[i];
                  if (typeof middleware !== 'function') continue;

                  let rest: Promise<void> | undefined;
                  const next = (_call?: unknown, replacement?: unknown) =>
                    (rest ??= runFrom(
                      i + 1,
                      typeof replacement === 'function' ? replacement : current
                    ));
                  await (middleware as any)(call, current, next);
                  if (rest) {
                    // The remainder ran inside this middleware; wait for it even
                    // if the middleware did not, so a failure is never dropped
                    await rest;
                    return;
                  }
                }
                if (answered) return;
                handlerRan = true;
                await finalHandler.call(
                  implementation,
                  call,
                  current === chainCallback ? callback : current
                );
              };

              await runFrom(0, chainCallback);

              if (!handlerRan) {
                // A middleware answered the call: the handler must not run
                if (answeredWithError) {
                  this.stats.failedCalls++;
                  this.stats.byMethod[methodName].errors++;
                } else {
                  this.stats.successfulCalls++;
                  this.updateAverageLatency(Date.now() - startTime, methodName);
                }
                return;
              }
            } else {
              await finalHandler.call(implementation, call, callback);
            }

            this.stats.successfulCalls++;
            const latency = Date.now() - startTime;
            this.updateAverageLatency(latency, methodName);
          } catch (error) {
            this.stats.failedCalls++;
            this.stats.byMethod[methodName].errors++;

            if (callback) {
              const grpcError = this.createGrpcError(error, methodName);
              callback(grpcError);
            } else {
              call.emit('error', this.createGrpcError(error, methodName));
            }
          } finally {
            this.stats.activeCalls--;
          }
        };
      }

      if (unknownHandlers.length > 0) {
        this.logger.warn(
          `Service ${serviceName}: no method named ${unknownHandlers.join(', ')} in the service ` +
            `definition, so ${unknownHandlers.length === 1 ? 'that handler is' : 'those handlers are'} ` +
            `never called. Methods: ${methodNames.join(', ')}`,
          'Service'
        );
      }

      // Add service to server
      this.server.addService(grpcServiceDef, wrappedImplementation);

      const registration: ServiceRegistration = {
        serviceName,
        methods: methodNames,
      };

      this.serviceRegistrations.set(serviceName, registration);

      this.logger.info(
        `Service registered: ${serviceName} with ${methodNames.length} method(s)`,
        'Service'
      );

      return registration;
    } catch (error) {
      this.logger.error(`Failed to register service ${serviceName}: ${error}`, 'Service');
      throw error;
    }
  }

  async start(): Promise<GrpcServer> {
    if (!this.server) {
      throw new Error('gRPC server not initialized. Call initialize() first.');
    }

    if (this.isStarted) {
      throw new Error('gRPC server already started');
    }

    return new Promise((resolve, reject) => {
      try {
        const host = this.options.host || '0.0.0.0';
        const port = this.options.port || 50051;
        const address = `${host}:${port}`;

        // Setup credentials
        let credentials: any;

        if (this.options.credentials) {
          const { rootCerts, privateKey, certChain } = this.options.credentials;
          // `checkServerIdentity` is the earlier name of the same setting
          const requireClientCert =
            this.options.credentials.requireClientCert ??
            this.options.credentials.checkServerIdentity ??
            false;
          credentials = this.grpcJs.ServerCredentials.createSsl(
            rootCerts || null,
            privateKey && certChain
              ? [
                  {
                    private_key: privateKey,
                    cert_chain: certChain,
                  },
                ]
              : [],
            requireClientCert
          );
          this.logger.info('Using SSL/TLS credentials', 'Start');
        } else {
          credentials = this.grpcJs.ServerCredentials.createInsecure();
          this.logger.info('Using insecure credentials', 'Start');
          if (!isLoopbackHost(host)) {
            this.logger.warn(
              `gRPC is listening on ${address} without TLS: calls and their metadata ` +
                '(tokens included) are sent unencrypted, and any host that can reach the port ' +
                "can call the services. Either set `host: '127.0.0.1'` to accept local " +
                'connections only, or set `credentials` to serve TLS; with `rootCerts` and ' +
                '`requireClientCert: true` in them, only clients holding a certificate you ' +
                'issued can connect.',
              'Start'
            );
          }
        }

        // Bind and start server
        this.server.bindAsync(address, credentials, (error: Error | null, port: number) => {
          if (error) {
            this.logger.error(`Failed to bind server: ${error.message}`, 'Start');
            reject(error);
            return;
          }

          this.boundAddress = `${host}:${port}`;
          this.isStarted = true;

          this.logger.info(`gRPC server listening on ${this.boundAddress}`, 'Start');

          const serverInstance: GrpcServer = {
            start: async () => {
              // Already started
            },
            stop: async () => {
              await this.stop();
            },
            forceShutdown: () => {
              this.server?.forceShutdown();
              this.isStarted = false;
            },
            getPort: () => port,
            getStats: () => ({ ...this.stats }),
          };

          resolve(serverInstance);
        });
      } catch (error) {
        this.logger.error(`Failed to start gRPC server: ${error}`, 'Start');
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.server || !this.isStarted) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server.tryShutdown((error: Error | null) => {
        if (error) {
          this.logger.error(`Error during shutdown: ${error.message}`, 'Stop');
          reject(error);
          return;
        }

        this.isStarted = false;
        this.logger.info('gRPC server stopped gracefully', 'Stop');
        resolve();
      });
    });
  }

  async createClient(
    protoPath: string,
    serviceName: string,
    options: GrpcClientOptions
  ): Promise<GrpcClient> {
    if (!this.grpcJs) {
      throw new Error('gRPC modules not initialized. Call initialize() first.');
    }

    try {
      // Load proto file
      const services = await this.loadProto(protoPath);
      const serviceDefinition = findServiceDefinition(services, serviceName);

      if (!serviceDefinition) {
        throw new Error(
          `Service ${serviceName} not found in proto file ${protoPath}. Available services: ${services.map(qualifiedServiceName).join(', ')}`
        );
      }

      // Setup credentials
      const credentials = this.clientCredentials(options.credentials);

      // Build client options
      const clientOptions: any = {};

      if (options.maxReceiveMessageLength) {
        clientOptions['grpc.max_receive_message_length'] = options.maxReceiveMessageLength;
      }
      if (options.maxSendMessageLength) {
        clientOptions['grpc.max_send_message_length'] = options.maxSendMessageLength;
      }

      // Custom channel options, as on the server
      Object.assign(clientOptions, options.channelOptions);

      // Accepted by GrpcClientOptions, applied by nothing
      for (const unapplied of ['deadline', 'interceptors'] as const) {
        if (options[unapplied] !== undefined) {
          this.logger.warn(
            `gRPC client option \`${unapplied}\` is not implemented and has no effect. Pass ` +
              `\`{ ${unapplied} }\` in the call options of each call instead: ` +
              `client.Method(request, { ${unapplied} }).`,
            'Client'
          );
        }
      }

      // Create client stub
      const ClientConstructor = this.buildClientConstructor(serviceDefinition);
      const client = new ClientConstructor(options.address, credentials, clientOptions);

      this.logger.info(`Created gRPC client for ${serviceName} at ${options.address}`, 'Client');

      return client as GrpcClient;
    } catch (error) {
      this.logger.error(`Failed to create gRPC client: ${error}`, 'Client');
      throw error;
    }
  }

  enableHealthCheck(): void {
    if (!this.server) {
      throw new Error('gRPC server not initialized. Call initialize() first.');
    }

    // Implement standard gRPC health checking protocol
    const healthService = {
      Check: (call: GrpcCall, callback: any) => {
        const response: HealthCheckResponse = {
          status: HealthCheckStatus.SERVING,
        };
        callback(null, response);
      },
      Watch: (call: GrpcCall) => {
        // Server streaming health check
        const response: HealthCheckResponse = {
          status: HealthCheckStatus.SERVING,
        };
        call.write?.(response);
      },
    };

    // grpc.health.v1.Health with its protobuf serialisers, so that standard
    // health probes can read the answer
    const healthPackage = this.protoLoader.fromJSON(HEALTH_PROTO_DESCRIPTOR, {
      keepCase: true,
      enums: String,
      defaults: true,
    });
    const healthServiceDef = findServiceDefinition(
      this.collectServices(this.grpcJs.loadPackageDefinition(healthPackage)),
      'grpc.health.v1.Health'
    );
    if (!healthServiceDef) {
      throw new Error('Could not build the grpc.health.v1.Health service definition');
    }

    this.addService('Health', healthServiceDef, healthService);
    this.logger.info('Health check service enabled', 'Health');
  }

  enableReflection(): void {
    if (!this.server) {
      throw new Error('gRPC server not initialized. Call initialize() first.');
    }

    // Server reflection (what lets grpcurl and similar tools discover
    // services) is not implemented: no reflection service is registered.
    if (this.reflectionWarned) return;
    this.reflectionWarned = true;
    this.logger.warn(
      'gRPC option `enableReflection` is not implemented and has no effect: no reflection ' +
        'service is registered, so tools such as grpcurl cannot discover services from this ' +
        'server. Give them the .proto files instead.',
      'Reflection'
    );
  }

  getAdapterName(): string {
    return '@grpc/grpc-js';
  }

  async isAvailable(): Promise<boolean> {
    return isPackageAvailable('@grpc/grpc-js') && isPackageAvailable('@grpc/proto-loader');
  }

  /**
   * The status a failed call is answered with.
   *
   * An error that carries a gRPC status code is the handler (or a middleware)
   * speaking to the client: code and message go out as given. Any other error
   * is something that went wrong inside the handler, and its text can hold
   * what a client has no business reading (a file path, a connection string,
   * a query). In production (`NODE_ENV=production`) such an error is logged
   * here and the client gets the status's standard text, as a failed HTTP
   * handler's client gets "Internal server error". Outside production the
   * message goes out, which is what makes a failing call debuggable.
   */
  private createGrpcError(error: any, methodName?: string): any {
    const grpcError: any = {
      code: GrpcStatusCode.INTERNAL,
      message: error instanceof Error ? error.message : String(error),
    };

    // Trailing metadata the error carries travels with the status
    if (error?.metadata && typeof error.metadata.getMap === 'function') {
      grpcError.metadata = error.metadata;
    }

    // An error that already carries a gRPC status code keeps it (the built-in
    // auth and validation middleware set one; so can a handler)
    const explicitCode = explicitGrpcStatus(error);
    if (explicitCode !== undefined) {
      grpcError.code = explicitCode;
      return grpcError;
    }

    // Map common errors to gRPC status codes
    if (error.message?.includes('not found')) {
      grpcError.code = GrpcStatusCode.NOT_FOUND;
    } else if (
      error.message?.includes('unauthorized') ||
      error.message?.includes('unauthenticated')
    ) {
      grpcError.code = GrpcStatusCode.UNAUTHENTICATED;
    } else if (error.message?.includes('permission denied')) {
      grpcError.code = GrpcStatusCode.PERMISSION_DENIED;
    } else if (error.message?.includes('invalid')) {
      grpcError.code = GrpcStatusCode.INVALID_ARGUMENT;
    }

    if (process.env.NODE_ENV === 'production') {
      this.logger.error(
        `gRPC call${methodName ? ` ${methodName}` : ''} failed: ${grpcError.message}`,
        'Handler',
        {
          code: grpcError.code,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        }
      );
      grpcError.message = GENERIC_STATUS_TEXT[grpcError.code as number] ?? 'Internal server error';
    }

    return grpcError;
  }

  private updateAverageLatency(latency: number, methodName: string): void {
    const totalCalls = this.stats.totalCalls;
    this.stats.averageLatency =
      (this.stats.averageLatency * (totalCalls - 1) + latency) / totalCalls;

    const methodStats = this.stats.byMethod[methodName];
    if (!methodStats) return;
    const methodCalls = methodStats.calls;
    methodStats.averageLatency =
      (methodStats.averageLatency * (methodCalls - 1) + latency) / methodCalls;
  }

  /**
   * What grpc-js needs to know about a method: its path, streaming mode and
   * serialisers. The serialisers are the protobuf ones the loaded .proto
   * carries. A definition built by hand, without them, keeps the JSON encoding
   * such definitions have always had (`protobuf` is then false).
   */
  private wireFormat(methodDef: MethodDefinition): { protobuf: boolean; definition: any } {
    const protobuf =
      typeof methodDef.requestSerialize === 'function' &&
      typeof methodDef.requestDeserialize === 'function' &&
      typeof methodDef.responseSerialize === 'function' &&
      typeof methodDef.responseDeserialize === 'function';

    const definition: any = {
      path: methodDef.path,
      requestStream: methodDef.requestStream,
      responseStream: methodDef.responseStream,
      requestSerialize: methodDef.requestSerialize ?? jsonSerialize,
      requestDeserialize: methodDef.requestDeserialize ?? jsonDeserialize,
      responseSerialize: methodDef.responseSerialize ?? jsonSerialize,
      responseDeserialize: methodDef.responseDeserialize ?? jsonDeserialize,
    };
    if (methodDef.originalName) {
      definition.originalName = methodDef.originalName;
    }

    return { protobuf, definition };
  }

  /**
   * Channel credentials for a client. No `credentials`, or the string
   * 'insecure', is a plaintext channel. A grpc-js ChannelCredentials object
   * (grpc.credentials.createInsecure(), createSsl(), ...) is used as given.
   * PEM contents `{ rootCerts, privateKey, certChain }` make a TLS channel.
   */
  private clientCredentials(value: unknown): any {
    const grpc = this.grpcJs;

    if (!value || value === 'insecure') {
      return grpc.credentials.createInsecure();
    }

    if (
      (typeof grpc.ChannelCredentials === 'function' && value instanceof grpc.ChannelCredentials) ||
      typeof (value as { _isSecure?: unknown })._isSecure === 'function'
    ) {
      return value;
    }

    const { rootCerts, privateKey, certChain } = value as GrpcCredentials;
    return grpc.credentials.createSsl(rootCerts, privateKey, certChain);
  }

  private buildClientConstructor(serviceDefinition: ServiceDefinition): any {
    if (!this.grpcJs) {
      throw new Error('gRPC modules not initialized');
    }

    const methodsDefinition: any = {};

    for (const [methodName, methodDef] of Object.entries(serviceDefinition.methods)) {
      methodsDefinition[methodName] = this.wireFormat(methodDef).definition;
    }

    const Client = this.grpcJs.makeGenericClientConstructor(
      methodsDefinition,
      serviceDefinition.serviceName
    );

    // A unary method called without a callback returns a promise of the
    // response; with a callback it behaves as grpc-js defines it. Streaming
    // methods are left as they are: they return the grpc-js call stream.
    for (const [methodName, methodDef] of Object.entries(serviceDefinition.methods)) {
      if (methodDef.requestStream || methodDef.responseStream) continue;

      const callbackForm = Client.prototype[methodName];
      if (typeof callbackForm !== 'function') continue;

      const method = function (this: unknown, ...args: any[]) {
        if (typeof args[args.length - 1] === 'function') {
          return callbackForm.apply(this, args);
        }
        return new Promise((resolve, reject) => {
          callbackForm.call(this, ...args, (error: unknown, response: unknown) => {
            if (error) reject(error);
            else resolve(response);
          });
        });
      };
      // grpc-js keeps the method's attributes (path, serialisers) on the function
      Object.assign(method, callbackForm);

      const alias = methodDef.originalName;
      if (alias && alias !== methodName && Client.prototype[alias] === callbackForm) {
        Client.prototype[alias] = method;
      }
      Client.prototype[methodName] = method;
    }

    return Client;
  }
}
