import { Server as SocketIOServer } from 'socket.io';
import { EventEmitter } from 'events';
import { MoroHttpServer } from './http';
import { ModuleConfig } from '../types/module';
import { LoggerOptions } from '../types/logger';
export interface MoroOptions {
  http2?: boolean;
  https?: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: string | Buffer;
  };
  compression?: {
    enabled?: boolean;
    threshold?: number;
  };
  websocket?: {
    compression?: boolean;
    customIdGenerator?: () => string;
  };
  logger?: LoggerOptions | boolean;
}
export declare class Moro extends EventEmitter {
  private httpServer;
  private server;
  private io;
  private container;
  private moduleLoader;
  private websocketManager;
  private circuitBreakers;
  private rateLimiters;
  private ioInstance;
  private eventBus;
  private logger;
  private options;
  constructor(options?: MoroOptions);
  use(middleware: any): this;
  private setupCore;
  private requestTrackingMiddleware;
  private errorBoundaryMiddleware;
  addMiddleware(middleware: any): this;
  registerDatabase(adapter: any): this;
  getHttpServer(): MoroHttpServer;
  getIOServer(): SocketIOServer<
    import('socket.io').DefaultEventsMap,
    import('socket.io').DefaultEventsMap,
    import('socket.io').DefaultEventsMap,
    any
  >;
  loadModule(moduleConfig: ModuleConfig): Promise<void>;
  private registerServices;
  private createModuleRouter;
  private createResilientHandler;
  private mountRouter;
  private setupWebSocketHandlers;
  private checkRateLimit;
  private getCircuitBreaker;
  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  set(key: string, value: any): void;
  get(key: string): any;
}
