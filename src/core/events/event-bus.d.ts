import {
  EventContext,
  EventPayload,
  EventBusOptions,
  ModuleEventBus,
  GlobalEventBus,
  EventMetrics,
  EventHandler,
} from '../../types/events';
export declare class MoroEventBus implements GlobalEventBus {
  private options;
  private emitter;
  private moduleBuses;
  private metrics;
  private auditEnabled;
  private auditLog;
  private latencySum;
  private errorCount;
  private logger;
  constructor(options?: EventBusOptions);
  emit<T = any>(event: string, data: T, context?: Partial<EventContext>): Promise<boolean>;
  on<T = any>(event: string, listener: EventHandler<T>): this;
  once<T = any>(event: string, listener: EventHandler<T>): this;
  off(event: string, listener: Function): this;
  removeAllListeners(event?: string): this;
  listenerCount(event: string): number;
  createModuleBus(moduleId: string): ModuleEventBus;
  destroyModuleBus(moduleId: string): void;
  getMetrics(): EventMetrics;
  enableAuditLog(): void;
  disableAuditLog(): void;
  getAuditLog(): EventPayload[];
  private updateMetrics;
  private generateRequestId;
}
