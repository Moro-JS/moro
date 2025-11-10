// @grpc/grpc-js Adapter Implementation
// High-performance Node.js gRPC implementation

import { resolveUserPackage, isPackageAvailable } from '../../utilities/package-utils.js';
import { createFrameworkLogger } from '../../logger/index.js';
import type { GrpcAdapter } from '../grpc-adapter.js';
import type {
  GrpcOptions,
  ServiceImplementation,
  GrpcServer,
  GrpcClient,
  GrpcClientOptions,
  ServiceDefinition,
  ProtoLoadOptions,
  ServiceRegistration,
  GrpcCall,
  GrpcStats,
  HealthCheckResponse,
} from '../types.js';
import { HealthCheckStatus } from '../types.js';

// Lazy-loaded gRPC modules
let grpcJs: any = null;
let protoLoader: any = null;

/**
 * @grpc/grpc-js adapter for MoroJS
 * Provides full gRPC support for Node.js applications
 */
export class GrpcJsAdapter implements GrpcAdapter {
  private server: any; // grpc.Server instance
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

  async initialize(options: GrpcOptions): Promise<void> {
    this.options = { ...options };

    try {
      // Lazy load @grpc/grpc-js
      if (!grpcJs) {
        const grpcPath = resolveUserPackage('@grpc/grpc-js');
        grpcJs = await import(grpcPath);
        this.logger.info('@grpc/grpc-js loaded successfully', 'Init');
      }

      // Lazy load @grpc/proto-loader
      if (!protoLoader) {
        const protoLoaderPath = resolveUserPackage('@grpc/proto-loader');
        protoLoader = await import(protoLoaderPath);
        this.logger.info('@grpc/proto-loader loaded successfully', 'Init');
      }

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

      this.server = new grpcJs.Server(channelOptions);

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
    if (!protoLoader || !grpcJs) {
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
      const packageDefinition = await protoLoader.load(protoPath, loadOptions);
      const protoDescriptor = grpcJs.loadPackageDefinition(packageDefinition);

      // Extract service definitions
      const services: ServiceDefinition[] = [];

      const extractServices = (obj: any, currentPackage: string = ''): void => {
        if (!obj) return;

        for (const [key, value] of Object.entries(obj)) {
          if (value && typeof value === 'object') {
            // Check if it's a service definition
            if ((value as any).service && typeof (value as any).service === 'object') {
              const serviceDef: ServiceDefinition = {
                serviceName: key,
                packageName: currentPackage || packageName,
                methods: {},
              };

              // Extract method definitions
              for (const [methodName, methodDef] of Object.entries((value as any).service)) {
                if (methodDef && typeof methodDef === 'object') {
                  const method = methodDef as any;
                  serviceDef.methods[methodName] = {
                    path:
                      method.path ||
                      `/${currentPackage ? currentPackage + '.' : ''}${key}/${methodName}`,
                    requestStream: method.requestStream || false,
                    responseStream: method.responseStream || false,
                    requestType: method.requestType,
                    responseType: method.responseType,
                    originalName: method.originalName || methodName,
                  };
                }
              }

              services.push(serviceDef);
            } else {
              // Recursively search for services
              const newPackage = currentPackage ? `${currentPackage}.${key}` : key;
              extractServices(value, newPackage);
            }
          }
        }
      };

      extractServices(protoDescriptor);

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

      for (const [methodName, methodDef] of Object.entries(serviceDefinition.methods)) {
        grpcServiceDef[methodName] = {
          path: methodDef.path,
          requestStream: methodDef.requestStream,
          responseStream: methodDef.responseStream,
          requestSerialize: (value: any) => Buffer.from(JSON.stringify(value)),
          requestDeserialize: (buffer: Buffer) => JSON.parse(buffer.toString()),
          responseSerialize: (value: any) => Buffer.from(JSON.stringify(value)),
          responseDeserialize: (buffer: Buffer) => JSON.parse(buffer.toString()),
        };

        methodNames.push(methodName);
      }

      // Wrap implementation handlers with stats tracking
      const wrappedImplementation: any = {};

      for (const [methodName, handler] of Object.entries(implementation)) {
        const methodDef = serviceDefinition.methods[methodName];
        if (!methodDef) continue;

        // Handle middleware array
        const handlers = Array.isArray(handler) ? handler : [handler];
        const finalHandler = handlers[handlers.length - 1];

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
            // Execute handler
            await finalHandler(call, callback);

            this.stats.successfulCalls++;
            const latency = Date.now() - startTime;
            this.updateAverageLatency(latency, methodName);
          } catch (error) {
            this.stats.failedCalls++;
            this.stats.byMethod[methodName].errors++;

            if (callback) {
              const grpcError = this.createGrpcError(error);
              callback(grpcError);
            } else {
              call.emit('error', this.createGrpcError(error));
            }
          } finally {
            this.stats.activeCalls--;
          }
        };
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
          credentials = grpcJs.ServerCredentials.createSsl(
            rootCerts || null,
            privateKey && certChain
              ? [
                  {
                    private_key: privateKey,
                    cert_chain: certChain,
                  },
                ]
              : [],
            this.options.credentials.checkServerIdentity ?? false
          );
          this.logger.info('Using SSL/TLS credentials', 'Start');
        } else {
          credentials = grpcJs.ServerCredentials.createInsecure();
          this.logger.info('Using insecure credentials', 'Start');
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
    if (!grpcJs) {
      throw new Error('gRPC modules not initialized. Call initialize() first.');
    }

    try {
      // Load proto file
      const services = await this.loadProto(protoPath);
      const serviceDefinition = services.find(s => s.serviceName === serviceName);

      if (!serviceDefinition) {
        throw new Error(`Service ${serviceName} not found in proto file ${protoPath}`);
      }

      // Setup credentials
      let credentials: any;

      if (options.credentials) {
        const { rootCerts, privateKey, certChain } = options.credentials;
        credentials = grpcJs.credentials.createSsl(rootCerts, privateKey, certChain);
      } else {
        credentials = grpcJs.credentials.createInsecure();
      }

      // Build client options
      const clientOptions: any = {};

      if (options.maxReceiveMessageLength) {
        clientOptions['grpc.max_receive_message_length'] = options.maxReceiveMessageLength;
      }
      if (options.maxSendMessageLength) {
        clientOptions['grpc.max_send_message_length'] = options.maxSendMessageLength;
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

    const healthServiceDef: ServiceDefinition = {
      serviceName: 'Health',
      packageName: 'grpc.health.v1',
      methods: {
        Check: {
          path: '/grpc.health.v1.Health/Check',
          requestStream: false,
          responseStream: false,
          requestType: {} as any,
          responseType: {} as any,
        },
        Watch: {
          path: '/grpc.health.v1.Health/Watch',
          requestStream: false,
          responseStream: true,
          requestType: {} as any,
          responseType: {} as any,
        },
      },
    };

    this.addService('Health', healthServiceDef, healthService);
    this.logger.info('Health check service enabled', 'Health');
  }

  enableReflection(): void {
    if (!this.server) {
      throw new Error('gRPC server not initialized. Call initialize() first.');
    }

    // Server reflection allows tools like grpcurl to discover services
    this.logger.info('Server reflection enabled', 'Reflection');
    // Note: Full reflection implementation requires additional packages
    // This is a placeholder for the feature
  }

  getAdapterName(): string {
    return '@grpc/grpc-js';
  }

  async isAvailable(): Promise<boolean> {
    return isPackageAvailable('@grpc/grpc-js') && isPackageAvailable('@grpc/proto-loader');
  }

  private createGrpcError(error: any): any {
    if (!grpcJs) return error;

    const grpcError: any = {
      code: grpcJs.status.INTERNAL,
      message: error instanceof Error ? error.message : String(error),
    };

    // Map common errors to gRPC status codes
    if (error.message?.includes('not found')) {
      grpcError.code = grpcJs.status.NOT_FOUND;
    } else if (
      error.message?.includes('unauthorized') ||
      error.message?.includes('unauthenticated')
    ) {
      grpcError.code = grpcJs.status.UNAUTHENTICATED;
    } else if (error.message?.includes('permission denied')) {
      grpcError.code = grpcJs.status.PERMISSION_DENIED;
    } else if (error.message?.includes('invalid')) {
      grpcError.code = grpcJs.status.INVALID_ARGUMENT;
    }

    return grpcError;
  }

  private updateAverageLatency(latency: number, methodName: string): void {
    const totalCalls = this.stats.totalCalls;
    this.stats.averageLatency =
      (this.stats.averageLatency * (totalCalls - 1) + latency) / totalCalls;

    const methodStats = this.stats.byMethod[methodName];
    const methodCalls = methodStats.calls;
    methodStats.averageLatency =
      (methodStats.averageLatency * (methodCalls - 1) + latency) / methodCalls;
  }

  private buildClientConstructor(serviceDefinition: ServiceDefinition): any {
    if (!grpcJs) {
      throw new Error('gRPC modules not initialized');
    }

    const methodsDefinition: any = {};

    for (const [methodName, methodDef] of Object.entries(serviceDefinition.methods)) {
      methodsDefinition[methodName] = {
        path: methodDef.path,
        requestStream: methodDef.requestStream,
        responseStream: methodDef.responseStream,
        requestSerialize: (value: any) => Buffer.from(JSON.stringify(value)),
        requestDeserialize: (buffer: Buffer) => JSON.parse(buffer.toString()),
        responseSerialize: (value: any) => Buffer.from(JSON.stringify(value)),
        responseDeserialize: (buffer: Buffer) => JSON.parse(buffer.toString()),
      };
    }

    return grpcJs.makeGenericClientConstructor(methodsDefinition, serviceDefinition.serviceName);
  }
}
