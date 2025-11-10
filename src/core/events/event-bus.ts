// Enterprise Event Bus - Secure, Scalable, Observable
import { EventEmitter } from 'events';
import {
  EventContext,
  EventPayload,
  EventBusOptions,
  ModuleEventBus,
  GlobalEventBus,
  EventMetrics,
  EventHandler,
} from '../../types/events.js';
import { createFrameworkLogger } from '../logger/index.js';

export class MoroEventBus implements GlobalEventBus {
  private emitter = new EventEmitter();
  private moduleBuses = new Map<string, ModuleEventBus>();
  private metrics: EventMetrics = {
    totalEvents: 0,
    eventsByType: {},
    eventsByModule: {},
    averageLatency: 0,
    errorRate: 0,
  };
  private auditEnabled = false;
  private auditLog: EventPayload[] = [];
  private latencySum = 0;
  private errorCount = 0;
  private logger = createFrameworkLogger('EventBus');

  constructor(private options: EventBusOptions = {}) {
    this.emitter.setMaxListeners(options.maxListeners || 100);
  }

  // Global event emission with full context and metrics
  async emit<T = any>(event: string, data: T, context?: Partial<EventContext>): Promise<boolean> {
    // Check listeners FIRST - most events have zero listeners
    // This early exit avoids ALL work below (timestamp, ID generation, metrics, etc.)
    const listenerCount = this.emitter.listenerCount(event);
    if (listenerCount === 0) {
      return false; // Zero overhead when no listeners - instant return
    }

    // Only do expensive work if there ARE listeners
    const startTime = Date.now();

    const fullContext: EventContext = {
      timestamp: new Date(),
      source: 'framework',
      requestId: this.generateRequestId(),
      ...context,
    };

    const payload: EventPayload<T> = {
      context: fullContext,
      data,
    };

    try {
      // Update metrics
      this.updateMetrics(event, fullContext.moduleId);

      // Audit logging - early exit if disabled
      if (this.auditEnabled) {
        this.auditLog.push(payload);
        if (this.auditLog.length > 1000) {
          this.auditLog = this.auditLog.slice(-500); // Keep last 500 events
        }
      }

      // Emit to global listeners
      const result = this.emitter.emit(event, payload);

      // Calculate latency
      const latency = Date.now() - startTime;
      this.latencySum += latency;

      return result;
    } catch (error) {
      this.errorCount++;
      this.logger.error(`Event emission error for ${event}`, 'Emission', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // Type-safe event listeners with automatic payload unwrapping
  on<T = any>(event: string, listener: EventHandler<T>): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<T = any>(event: string, listener: EventHandler<T>): this {
    this.emitter.once(event, listener);
    return this;
  }

  off(event: string, listener: CallableFunction): this {
    this.emitter.off(event, listener as (...args: any[]) => void);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.emitter.listenerCount(event);
  }

  // Create isolated module event bus with namespace protection
  createModuleBus(moduleId: string): ModuleEventBus {
    // Return existing bus if it already exists
    if (this.moduleBuses.has(moduleId)) {
      this.logger.debug(`Reusing existing event bus for module: ${moduleId}`, 'ModuleBus');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.moduleBuses.get(moduleId)!;
    }

    const moduleBus = new ModuleEventBusImpl(moduleId, this);
    this.moduleBuses.set(moduleId, moduleBus);

    this.logger.debug(`Created event bus for module: ${moduleId}`, 'ModuleBus');
    return moduleBus;
  }

  // Clean up module resources
  destroyModuleBus(moduleId: string): void {
    const moduleBus = this.moduleBuses.get(moduleId);
    if (moduleBus) {
      moduleBus.removeAllListeners();
      this.moduleBuses.delete(moduleId);
      this.logger.debug(`Destroyed event bus for module: ${moduleId}`, 'ModuleBus');
    }
  }

  // Comprehensive event metrics
  getMetrics(): EventMetrics {
    return {
      ...this.metrics,
      averageLatency: this.metrics.totalEvents > 0 ? this.latencySum / this.metrics.totalEvents : 0,
      errorRate:
        this.metrics.totalEvents > 0 ? (this.errorCount / this.metrics.totalEvents) * 100 : 0,
    };
  }

  // Enable audit logging for compliance
  enableAuditLog(): void {
    this.auditEnabled = true;
    this.logger.info('Event audit logging enabled', 'Audit');
  }

  disableAuditLog(): void {
    this.auditEnabled = false;
    this.auditLog = [];
    this.logger.info('Event audit logging disabled', 'Audit');
  }

  // Get audit log for compliance reporting
  getAuditLog(): EventPayload[] {
    return [...this.auditLog];
  }

  private updateMetrics(event: string, moduleId?: string): void {
    this.metrics.totalEvents++;
    this.metrics.eventsByType[event] = (this.metrics.eventsByType[event] || 0) + 1;

    if (moduleId) {
      this.metrics.eventsByModule[moduleId] = (this.metrics.eventsByModule[moduleId] || 0) + 1;
    }
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Module-isolated event bus implementation
class ModuleEventBusImpl implements ModuleEventBus {
  constructor(
    private moduleId: string,
    private globalBus: MoroEventBus
  ) {}

  async emit<T = any>(event: string, data: T): Promise<boolean> {
    // Module events are namespaced to prevent conflicts
    const namespacedEvent = `module:${this.moduleId}:${event}`;

    return this.globalBus.emit(namespacedEvent, data, {
      source: 'module',
      moduleId: this.moduleId,
    });
  }

  on<T = any>(event: string, listener: (payload: EventPayload<T>) => void | Promise<void>): this {
    const namespacedEvent = `module:${this.moduleId}:${event}`;
    this.globalBus.on(namespacedEvent, listener);
    return this;
  }

  once<T = any>(event: string, listener: (payload: EventPayload<T>) => void | Promise<void>): this {
    const namespacedEvent = `module:${this.moduleId}:${event}`;
    this.globalBus.once(namespacedEvent, listener);
    return this;
  }

  off(event: string, listener: CallableFunction): this {
    const namespacedEvent = `module:${this.moduleId}:${event}`;
    this.globalBus.off(namespacedEvent, listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      const namespacedEvent = `module:${this.moduleId}:${event}`;
      this.globalBus.removeAllListeners(namespacedEvent);
    } else {
      // Remove all module events - would need access to globalBus emitter
      // For now, this is a simplified implementation
      const logger = createFrameworkLogger('EventBus');
      logger.warn(
        `Removing all listeners for module ${this.moduleId} not fully implemented`,
        'ModuleBus'
      );
    }
    return this;
  }

  listenerCount(event: string): number {
    const namespacedEvent = `module:${this.moduleId}:${event}`;
    return this.globalBus.listenerCount(namespacedEvent);
  }
}
