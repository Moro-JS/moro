// Enterprise Event Bus - Secure, Scalable, Observable
import { EventEmitter } from 'events';
import crypto from 'crypto';
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
  private auditBuffer: EventPayload[] = new Array(1000);
  private auditHead = 0;
  private auditCount = 0;
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
        this.auditBuffer[this.auditHead] = payload;
        this.auditHead = (this.auditHead + 1) % 1000;
        if (this.auditCount < 1000) this.auditCount++;
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
    this.auditBuffer = new Array(1000);
    this.auditHead = 0;
    this.auditCount = 0;
    this.logger.info('Event audit logging disabled', 'Audit');
  }

  // Get audit log for compliance reporting
  getAuditLog(): EventPayload[] {
    if (this.auditCount === 0) return [];
    if (this.auditCount < 1000) {
      return this.auditBuffer.slice(0, this.auditCount);
    }
    // Ring buffer is full — return in chronological order
    return [
      ...this.auditBuffer.slice(this.auditHead),
      ...this.auditBuffer.slice(0, this.auditHead),
    ];
  }

  private updateMetrics(event: string, moduleId?: string): void {
    this.metrics.totalEvents++;
    this.metrics.eventsByType[event] = (this.metrics.eventsByType[event] || 0) + 1;

    if (moduleId) {
      this.metrics.eventsByModule[moduleId] = (this.metrics.eventsByModule[moduleId] || 0) + 1;
    }
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }
}

// Module-isolated event bus implementation
class ModuleEventBusImpl implements ModuleEventBus {
  private nameCache = new Map<string, string>();

  constructor(
    private moduleId: string,
    private globalBus: MoroEventBus
  ) {}

  private namespaced(event: string): string {
    let cached = this.nameCache.get(event);
    if (!cached) {
      cached = `module:${this.moduleId}:${event}`;
      this.nameCache.set(event, cached);
    }
    return cached;
  }

  async emit<T = any>(event: string, data: T): Promise<boolean> {
    return this.globalBus.emit(this.namespaced(event), data, {
      source: 'module',
      moduleId: this.moduleId,
    });
  }

  on<T = any>(event: string, listener: (payload: EventPayload<T>) => void | Promise<void>): this {
    this.globalBus.on(this.namespaced(event), listener);
    return this;
  }

  once<T = any>(event: string, listener: (payload: EventPayload<T>) => void | Promise<void>): this {
    this.globalBus.once(this.namespaced(event), listener);
    return this;
  }

  off(event: string, listener: CallableFunction): this {
    this.globalBus.off(this.namespaced(event), listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.globalBus.removeAllListeners(this.namespaced(event));
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
    return this.globalBus.listenerCount(this.namespaced(event));
  }
}
