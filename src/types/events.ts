// Enterprise Event System Types
import { EventEmitter } from 'events';

export interface EventContext {
  timestamp: Date;
  source: string;
  moduleId?: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface EventPayload<T = any> {
  context: EventContext;
  data: T;
}

export interface EventBusOptions {
  maxListeners?: number;
  enablePersistence?: boolean;
  enableMetrics?: boolean;
  isolation?: 'none' | 'module' | 'strict';
}

export interface ModuleEventBus {
  emit<T = any>(event: string, data: T): Promise<boolean>;
  on<T = any>(event: string, listener: (payload: EventPayload<T>) => void | Promise<void>): this;
  once<T = any>(event: string, listener: (payload: EventPayload<T>) => void | Promise<void>): this;
  off(event: string, listener: Function): this;
  removeAllListeners(event?: string): this;
  listenerCount(event: string): number;
}

export interface GlobalEventBus extends ModuleEventBus {
  createModuleBus(moduleId: string): ModuleEventBus;
  destroyModuleBus(moduleId: string): void;
  getMetrics(): EventMetrics;
  enableAuditLog(): void;
  disableAuditLog(): void;
}

export interface EventMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByModule: Record<string, number>;
  averageLatency: number;
  errorRate: number;
}

export type SystemEvents = {
  'framework:initialized': { options: any };
  'framework:shutdown': { graceful: boolean };
  'module:loading': { moduleId: string; path?: string };
  'module:loaded': { moduleId: string; version: string };
  'module:unloaded': { moduleId: string };
  'middleware:registered': { name: string; type: string };
  'middleware:installed': { name: string; options?: any };
  'database:connected': { adapter: string; config: any };
  'database:disconnected': { adapter: string };
  'server:starting': { port: number };
  'server:started': { port: number; pid: number };
  'server:stopping': { graceful: boolean };
  'request:start': { method: string; path: string; requestId: string };
  'request:end': {
    method: string;
    path: string;
    requestId: string;
    statusCode: number;
    duration: number;
  };
  'websocket:connected': { namespace: string; socketId: string };
  'websocket:disconnected': {
    namespace: string;
    socketId: string;
    reason: string;
  };
  'error:handled': { error: Error; context: string; requestId?: string };
  'error:unhandled': { error: Error; context: string };
};

export type EventHandler<T = any> = (payload: EventPayload<T>) => void | Promise<void>;
