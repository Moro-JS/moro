// gRPC Adapter Interface
// Base interface that all gRPC adapters must implement

import type {
  GrpcOptions,
  ServiceImplementation,
  GrpcServer,
  GrpcClient,
  GrpcClientOptions,
  ServiceDefinition,
  ProtoLoadOptions,
  ServiceRegistration,
} from './types.js';

/**
 * Base adapter interface for gRPC implementations
 * All gRPC adapters (@grpc/grpc-js, grpc-web) must implement this interface
 */
export interface GrpcAdapter {
  /**
   * Initialize the gRPC adapter
   */
  initialize(options: GrpcOptions): Promise<void>;

  /**
   * Load a proto file and return service definitions
   */
  loadProto(
    protoPath: string,
    packageName?: string,
    options?: ProtoLoadOptions
  ): Promise<ServiceDefinition[]>;

  /**
   * Register a gRPC service with implementation
   */
  addService(
    serviceName: string,
    serviceDefinition: ServiceDefinition,
    implementation: ServiceImplementation
  ): ServiceRegistration;

  /**
   * Start the gRPC server
   */
  start(): Promise<GrpcServer>;

  /**
   * Stop the gRPC server
   */
  stop(): Promise<void>;

  /**
   * Create a gRPC client for calling remote services
   */
  createClient(
    protoPath: string,
    serviceName: string,
    options: GrpcClientOptions
  ): Promise<GrpcClient>;

  /**
   * Enable health checking service
   */
  enableHealthCheck(): void;

  /**
   * Enable server reflection
   */
  enableReflection(): void;

  /**
   * Get adapter name
   */
  getAdapterName(): string;

  /**
   * Check if adapter is available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * A service's name with its proto package: `acme.inventory.v1.Inventory`.
 */
export function qualifiedServiceName(service: ServiceDefinition): string {
  return service.packageName
    ? `${service.packageName}.${service.serviceName}`
    : service.serviceName;
}

/**
 * Find a service among those a proto file defines, by its name (`Inventory`)
 * or its package-qualified name (`acme.inventory.v1.Inventory`). When several
 * packages of the file define a service of that name, `packageName` picks one;
 * without it the first is taken.
 */
export function findServiceDefinition(
  services: ServiceDefinition[],
  serviceName: string,
  packageName?: string
): ServiceDefinition | undefined {
  const matches = services.filter(
    service => service.serviceName === serviceName || qualifiedServiceName(service) === serviceName
  );
  if (packageName && matches.length > 1) {
    const inPackage = matches.find(service => service.packageName === packageName);
    if (inPackage) return inPackage;
  }
  return matches[0];
}
