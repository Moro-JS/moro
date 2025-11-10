// gRPC Manager - Main orchestrator for gRPC functionality
// Handles adapter initialization, service registration, and lifecycle management

import { createFrameworkLogger } from '../logger/index.js';
import { isPackageAvailable } from '../utilities/package-utils.js';
import type { GrpcAdapter } from './grpc-adapter.js';
import type {
  GrpcOptions,
  ServiceImplementation,
  GrpcServer,
  GrpcClient,
  GrpcClientOptions,
  ProtoLoadOptions,
  ServiceRegistration,
  GrpcStats,
} from './types.js';

/**
 * gRPC Manager for MoroJS
 * Manages gRPC server lifecycle, service registration, and client creation
 */
export class GrpcManager {
  private adapter?: GrpcAdapter;
  private options: GrpcOptions;
  private logger = createFrameworkLogger('GRPC_MANAGER');
  private server?: GrpcServer;
  private services = new Map<string, ServiceRegistration>();
  private isInitialized = false;
  private isStarted = false;

  constructor(options: GrpcOptions = {}) {
    this.options = {
      port: 50051,
      host: '0.0.0.0',
      adapter: 'grpc-js',
      enableHealthCheck: true,
      enableReflection: false,
      maxReceiveMessageLength: 4 * 1024 * 1024, // 4MB
      maxSendMessageLength: 4 * 1024 * 1024, // 4MB
      compression: true,
      ...options,
    };
  }

  /**
   * Initialize gRPC manager with the specified adapter
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.warn('gRPC manager already initialized', 'Init');
      return;
    }

    try {
      // Detect and load adapter
      const adapterName = this.options.adapter || 'grpc-js';

      if (adapterName === 'grpc-js') {
        await this.loadGrpcJsAdapter();
      } else {
        throw new Error(`Unknown gRPC adapter: ${adapterName}`);
      }

      if (!this.adapter) {
        throw new Error('Failed to load gRPC adapter');
      }

      // Initialize adapter
      await this.adapter.initialize(this.options);

      // Enable optional features
      if (this.options.enableHealthCheck) {
        this.adapter.enableHealthCheck();
        this.logger.info('Health check service enabled', 'Init');
      }

      if (this.options.enableReflection) {
        this.adapter.enableReflection();
        this.logger.info('Server reflection enabled', 'Init');
      }

      this.isInitialized = true;
      this.logger.info(`gRPC manager initialized with ${adapterName} adapter`, 'Init');
    } catch (error) {
      this.logger.error(`Failed to initialize gRPC manager: ${error}`, 'Init');
      throw error;
    }
  }

  /**
   * Register a gRPC service from a proto file
   */
  async registerService(
    protoPath: string,
    serviceName: string,
    implementation: ServiceImplementation,
    packageName?: string,
    protoOptions?: ProtoLoadOptions
  ): Promise<ServiceRegistration> {
    if (!this.isInitialized || !this.adapter) {
      throw new Error('gRPC manager not initialized. Call initialize() first.');
    }

    try {
      // Load proto file
      const services = await this.adapter.loadProto(protoPath, packageName, protoOptions);

      // Find the specified service
      const serviceDefinition = services.find(s => s.serviceName === serviceName);

      if (!serviceDefinition) {
        throw new Error(
          `Service ${serviceName} not found in ${protoPath}. Available services: ${services.map(s => s.serviceName).join(', ')}`
        );
      }

      // Register service
      const registration = this.adapter.addService(serviceName, serviceDefinition, implementation);

      this.services.set(serviceName, registration);

      this.logger.info(
        `Service ${serviceName} registered with ${registration.methods.length} method(s)`,
        'Service'
      );

      return registration;
    } catch (error) {
      this.logger.error(`Failed to register service ${serviceName}: ${error}`, 'Service');
      throw error;
    }
  }

  /**
   * Start the gRPC server
   */
  async start(): Promise<GrpcServer> {
    if (!this.isInitialized || !this.adapter) {
      throw new Error('gRPC manager not initialized. Call initialize() first.');
    }

    if (this.isStarted) {
      throw new Error('gRPC server already started');
    }

    try {
      this.server = await this.adapter.start();
      this.isStarted = true;

      const host = this.options.host || '0.0.0.0';
      const port = this.options.port || 50051;

      this.logger.info(`gRPC server started on ${host}:${port}`, 'Start');
      this.logger.info(
        `Registered services: ${Array.from(this.services.keys()).join(', ')}`,
        'Start'
      );

      return this.server;
    } catch (error) {
      this.logger.error(`Failed to start gRPC server: ${error}`, 'Start');
      throw error;
    }
  }

  /**
   * Stop the gRPC server gracefully
   */
  async stop(): Promise<void> {
    if (!this.isStarted || !this.adapter) {
      return;
    }

    try {
      await this.adapter.stop();
      this.isStarted = false;
      this.logger.info('gRPC server stopped', 'Stop');
    } catch (error) {
      this.logger.error(`Error stopping gRPC server: ${error}`, 'Stop');
      throw error;
    }
  }

  /**
   * Force shutdown the gRPC server
   */
  forceShutdown(): void {
    if (this.server) {
      this.server.forceShutdown();
      this.isStarted = false;
      this.logger.warn('gRPC server force shutdown', 'Stop');
    }
  }

  /**
   * Create a gRPC client for calling remote services
   */
  async createClient(
    protoPath: string,
    serviceName: string,
    address: string,
    options: Partial<GrpcClientOptions> = {}
  ): Promise<GrpcClient> {
    if (!this.isInitialized || !this.adapter) {
      throw new Error('gRPC manager not initialized. Call initialize() first.');
    }

    const clientOptions: GrpcClientOptions = {
      address,
      maxReceiveMessageLength: this.options.maxReceiveMessageLength,
      maxSendMessageLength: this.options.maxSendMessageLength,
      ...options,
    };

    try {
      const client = await this.adapter.createClient(protoPath, serviceName, clientOptions);

      this.logger.info(`Created gRPC client for ${serviceName} at ${address}`, 'Client');

      return client;
    } catch (error) {
      this.logger.error(`Failed to create gRPC client: ${error}`, 'Client');
      throw error;
    }
  }

  /**
   * Get statistics about the gRPC server
   */
  getStats(): GrpcStats | null {
    if (!this.server) {
      return null;
    }

    return this.server.getStats();
  }

  /**
   * Get list of registered services
   */
  getServices(): ServiceRegistration[] {
    return Array.from(this.services.values());
  }

  /**
   * Check if gRPC is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.isStarted;
  }

  /**
   * Get the gRPC server instance
   */
  getServer(): GrpcServer | undefined {
    return this.server;
  }

  /**
   * Load @grpc/grpc-js adapter dynamically
   */
  private async loadGrpcJsAdapter(): Promise<void> {
    if (!isPackageAvailable('@grpc/grpc-js')) {
      throw new Error(
        '@grpc/grpc-js package not found.\n' +
          'To use gRPC with MoroJS, install the required packages:\n' +
          '  npm install @grpc/grpc-js @grpc/proto-loader\n\n' +
          'Then configure gRPC in your app:\n' +
          "  app.grpc({ port: 50051, adapter: 'grpc-js' });"
      );
    }

    if (!isPackageAvailable('@grpc/proto-loader')) {
      throw new Error(
        '@grpc/proto-loader package not found.\n' +
          'To use gRPC with MoroJS, install the required packages:\n' +
          '  npm install @grpc/grpc-js @grpc/proto-loader'
      );
    }

    // Dynamic import of adapter
    const { GrpcJsAdapter } = await import('./adapters/grpc-js-adapter.js');
    this.adapter = new GrpcJsAdapter();

    this.logger.info('@grpc/grpc-js adapter loaded', 'Adapter');
  }
}
