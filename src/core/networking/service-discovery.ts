// Service Discovery Client for Microservices
// Supports Consul, Kubernetes, and in-memory registry

import { logger, createFrameworkLogger } from '../logger';

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

export class ServiceRegistry {
  private services = new Map<string, ServiceInfo[]>();
  private options: ServiceDiscoveryOptions;
  private healthCheckInterval?: NodeJS.Timeout;
  private serviceLogger = createFrameworkLogger('SERVICE_DISCOVERY');

  constructor(options: ServiceDiscoveryOptions) {
    this.options = options;
    this.startHealthChecks();
  }

  async register(service: ServiceInfo): Promise<void> {
    const { name } = service;

    switch (this.options.type) {
      case 'consul':
        await this.registerWithConsul(service);
        break;
      case 'kubernetes':
        await this.registerWithKubernetes(service);
        break;
      case 'memory':
        this.registerInMemory(service);
        break;
    }

    this.serviceLogger.info(`Service registered: ${name}@${service.host}:${service.port}`);
  }

  async discover(serviceName: string): Promise<ServiceInfo[]> {
    switch (this.options.type) {
      case 'consul':
        return this.discoverFromConsul(serviceName);
      case 'kubernetes':
        return this.discoverFromKubernetes(serviceName);
      case 'memory':
        return this.discoverFromMemory(serviceName);
      default:
        return [];
    }
  }

  async deregister(serviceName: string): Promise<void> {
    switch (this.options.type) {
      case 'consul':
        await this.deregisterFromConsul(serviceName);
        break;
      case 'kubernetes':
        // K8s handles this automatically
        break;
      case 'memory':
        this.services.delete(serviceName);
        break;
    }

    this.serviceLogger.info(`Service deregistered: ${serviceName}`);
  }

  // In-memory registry methods
  private registerInMemory(service: ServiceInfo): void {
    const existing = this.services.get(service.name) || [];
    const updated = existing.filter(s => s.host !== service.host || s.port !== service.port);
    updated.push(service);
    this.services.set(service.name, updated);
  }

  private discoverFromMemory(serviceName: string): ServiceInfo[] {
    return this.services.get(serviceName) || [];
  }

  // Consul integration
  private async registerWithConsul(service: ServiceInfo): Promise<void> {
    if (!this.options.consulUrl) {
      throw new Error('Consul URL required for consul service discovery');
    }

    const consulService = {
      ID: `${service.name}-${service.host}-${service.port}`,
      Name: service.name,
      Tags: service.tags || [],
      Address: service.host,
      Port: service.port,
      Check: service.health
        ? {
            HTTP: `http://${service.host}:${service.port}${service.health}`,
            Interval: '30s',
            Timeout: '10s',
          }
        : undefined,
      Meta: service.metadata || {},
    };

    try {
      const response = await fetch(`${this.options.consulUrl}/v1/agent/service/register`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(consulService),
      });

      if (!response.ok) {
        throw new Error(`Consul registration failed: ${response.statusText}`);
      }
    } catch (error) {
      this.serviceLogger.error('Failed to register with Consul:', 'ServiceRegistry', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback to in-memory
      this.registerInMemory(service);
    }
  }

  private async discoverFromConsul(serviceName: string): Promise<ServiceInfo[]> {
    if (!this.options.consulUrl) {
      return this.discoverFromMemory(serviceName);
    }

    try {
      const response = await fetch(
        `${this.options.consulUrl}/v1/health/service/${serviceName}?passing=true`
      );

      if (!response.ok) {
        throw new Error(`Consul discovery failed: ${response.statusText}`);
      }

      const services = (await response.json()) as any[];
      return services.map((entry: any) => ({
        name: entry.Service.Service,
        host: entry.Service.Address,
        port: entry.Service.Port,
        tags: entry.Service.Tags,
        metadata: entry.Service.Meta,
      }));
    } catch (error) {
      this.serviceLogger.error('Failed to discover from Consul:', 'ServiceRegistry', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.discoverFromMemory(serviceName);
    }
  }

  private async deregisterFromConsul(serviceName: string): Promise<void> {
    if (!this.options.consulUrl) return;

    try {
      await fetch(`${this.options.consulUrl}/v1/agent/service/deregister/${serviceName}`, {
        method: 'PUT',
      });
    } catch (error) {
      this.serviceLogger.error('Failed to deregister from Consul:', 'ServiceRegistry', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Kubernetes integration
  private async registerWithKubernetes(service: ServiceInfo): Promise<void> {
    // In Kubernetes, services are registered via Service/Endpoints resources
    // This would typically be handled by the K8s API, not application code
    this.serviceLogger.info(`K8s service registration: ${service.name} (handled by Kubernetes)`);

    // Fallback to in-memory for local development
    this.registerInMemory(service);
  }

  private async discoverFromKubernetes(serviceName: string): Promise<ServiceInfo[]> {
    // In K8s, we can discover services via DNS or the K8s API
    const namespace = this.options.kubernetesNamespace || 'default';

    try {
      // Try K8s service DNS resolution
      const host = `${serviceName}.${namespace}.svc.cluster.local`;

      // For demo purposes, return the service info
      // In production, you'd query the K8s API or use DNS
      return [
        {
          name: serviceName,
          host,
          port: 80, // Default port, should be discovered from service definition
          metadata: { discovered: 'kubernetes' },
        },
      ];
    } catch (error) {
      this.serviceLogger.error('Failed to discover from Kubernetes:', 'ServiceRegistry', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.discoverFromMemory(serviceName);
    }
  }

  // Health checking
  private startHealthChecks(): void {
    if (this.options.healthCheckInterval) {
      this.healthCheckInterval = setInterval(
        () => this.performHealthChecks(),
        this.options.healthCheckInterval
      );
    }
  }

  private async performHealthChecks(): Promise<void> {
    for (const [serviceName, services] of this.services.entries()) {
      for (const service of services) {
        if (service.health) {
          try {
            const response = await fetch(
              `http://${service.host}:${service.port}${service.health}`,
              {
                timeout: 5000,
              } as any
            );

            if (!response.ok) {
              this.serviceLogger.warn(
                `Health check failed for ${serviceName}: ${response.statusText}`
              );
              // Remove unhealthy service
              this.removeUnhealthyService(serviceName, service);
            }
          } catch (error) {
            this.serviceLogger.warn(`Health check failed for ${serviceName}:`, 'ServiceRegistry', {
              error: error instanceof Error ? error.message : String(error),
            });
            this.removeUnhealthyService(serviceName, service);
          }
        }
      }
    }
  }

  private removeUnhealthyService(serviceName: string, unhealthyService: ServiceInfo): void {
    const services = this.services.get(serviceName) || [];
    const filtered = services.filter(
      s => s.host !== unhealthyService.host || s.port !== unhealthyService.port
    );

    if (filtered.length === 0) {
      this.services.delete(serviceName);
    } else {
      this.services.set(serviceName, filtered);
    }
  }

  // Load balancing
  selectService(
    serviceName: string,
    strategy: 'round-robin' | 'random' | 'least-connections' = 'round-robin'
  ): ServiceInfo | null {
    const services = this.services.get(serviceName) || [];

    if (services.length === 0) {
      return null;
    }

    switch (strategy) {
      case 'random':
        return services[Math.floor(Math.random() * services.length)];
      case 'round-robin':
        // Simple round-robin (in production, maintain state)
        return services[Date.now() % services.length];
      case 'least-connections':
        // For demo, just return the first (in production, track connections)
        return services[0];
      default:
        return services[0];
    }
  }

  // Cleanup
  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }

  // Get all registered services
  getAllServices(): Record<string, ServiceInfo[]> {
    return Object.fromEntries(this.services.entries());
  }
}
