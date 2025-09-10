"use strict";
// Service Discovery Client for Microservices
// Supports Consul, Kubernetes, and in-memory registry
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceRegistry = void 0;
class ServiceRegistry {
    services = new Map();
    options;
    healthCheckInterval;
    constructor(options) {
        this.options = options;
        this.startHealthChecks();
    }
    async register(service) {
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
        console.log(`Service registered: ${name}@${service.host}:${service.port}`);
    }
    async discover(serviceName) {
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
    async deregister(serviceName) {
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
        console.log(`Service deregistered: ${serviceName}`);
    }
    // In-memory registry methods
    registerInMemory(service) {
        const existing = this.services.get(service.name) || [];
        const updated = existing.filter(s => s.host !== service.host || s.port !== service.port);
        updated.push(service);
        this.services.set(service.name, updated);
    }
    discoverFromMemory(serviceName) {
        return this.services.get(serviceName) || [];
    }
    // Consul integration
    async registerWithConsul(service) {
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
        }
        catch (error) {
            console.error('Failed to register with Consul:', error);
            // Fallback to in-memory
            this.registerInMemory(service);
        }
    }
    async discoverFromConsul(serviceName) {
        if (!this.options.consulUrl) {
            return this.discoverFromMemory(serviceName);
        }
        try {
            const response = await fetch(`${this.options.consulUrl}/v1/health/service/${serviceName}?passing=true`);
            if (!response.ok) {
                throw new Error(`Consul discovery failed: ${response.statusText}`);
            }
            const services = (await response.json());
            return services.map((entry) => ({
                name: entry.Service.Service,
                host: entry.Service.Address,
                port: entry.Service.Port,
                tags: entry.Service.Tags,
                metadata: entry.Service.Meta,
            }));
        }
        catch (error) {
            console.error('Failed to discover from Consul:', error);
            return this.discoverFromMemory(serviceName);
        }
    }
    async deregisterFromConsul(serviceName) {
        if (!this.options.consulUrl)
            return;
        try {
            await fetch(`${this.options.consulUrl}/v1/agent/service/deregister/${serviceName}`, {
                method: 'PUT',
            });
        }
        catch (error) {
            console.error('Failed to deregister from Consul:', error);
        }
    }
    // Kubernetes integration
    async registerWithKubernetes(service) {
        // In Kubernetes, services are registered via Service/Endpoints resources
        // This would typically be handled by the K8s API, not application code
        console.log(`K8s service registration: ${service.name} (handled by Kubernetes)`);
        // Fallback to in-memory for local development
        this.registerInMemory(service);
    }
    async discoverFromKubernetes(serviceName) {
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
        }
        catch (error) {
            console.error('Failed to discover from Kubernetes:', error);
            return this.discoverFromMemory(serviceName);
        }
    }
    // Health checking
    startHealthChecks() {
        if (this.options.healthCheckInterval) {
            this.healthCheckInterval = setInterval(() => this.performHealthChecks(), this.options.healthCheckInterval);
        }
    }
    async performHealthChecks() {
        for (const [serviceName, services] of this.services.entries()) {
            for (const service of services) {
                if (service.health) {
                    try {
                        const response = await fetch(`http://${service.host}:${service.port}${service.health}`, {
                            timeout: 5000,
                        });
                        if (!response.ok) {
                            console.warn(`Health check failed for ${serviceName}: ${response.statusText}`);
                            // Remove unhealthy service
                            this.removeUnhealthyService(serviceName, service);
                        }
                    }
                    catch (error) {
                        console.warn(`Health check failed for ${serviceName}:`, error);
                        this.removeUnhealthyService(serviceName, service);
                    }
                }
            }
        }
    }
    removeUnhealthyService(serviceName, unhealthyService) {
        const services = this.services.get(serviceName) || [];
        const filtered = services.filter(s => s.host !== unhealthyService.host || s.port !== unhealthyService.port);
        if (filtered.length === 0) {
            this.services.delete(serviceName);
        }
        else {
            this.services.set(serviceName, filtered);
        }
    }
    // Load balancing
    selectService(serviceName, strategy = 'round-robin') {
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
    destroy() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
    }
    // Get all registered services
    getAllServices() {
        return Object.fromEntries(this.services.entries());
    }
}
exports.ServiceRegistry = ServiceRegistry;
