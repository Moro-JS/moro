export interface ServiceInfo {
  name: string;
  host: string;
  port: number;
  health?: string;
  version?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}
export interface ServiceDiscoveryOptions {
  type: 'consul' | 'kubernetes' | 'memory';
  consulUrl?: string;
  kubernetesNamespace?: string;
  healthCheckInterval?: number;
  tags?: string[];
}
export declare class ServiceRegistry {
  private services;
  private options;
  private healthCheckInterval?;
  constructor(options: ServiceDiscoveryOptions);
  register(service: ServiceInfo): Promise<void>;
  discover(serviceName: string): Promise<ServiceInfo[]>;
  deregister(serviceName: string): Promise<void>;
  private registerInMemory;
  private discoverFromMemory;
  private registerWithConsul;
  private discoverFromConsul;
  private deregisterFromConsul;
  private registerWithKubernetes;
  private discoverFromKubernetes;
  private startHealthChecks;
  private performHealthChecks;
  private removeUnhealthyService;
  selectService(
    serviceName: string,
    strategy?: 'round-robin' | 'random' | 'least-connections'
  ): ServiceInfo | null;
  destroy(): void;
  getAllServices(): Record<string, ServiceInfo[]>;
}
