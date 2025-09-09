import { Server as SocketIOServer, Namespace } from 'socket.io';
import { Container } from '../utilities';
import { ModuleConfig, WebSocketDefinition } from '../../types/module';
export declare class WebSocketManager {
  private io;
  private container;
  private circuitBreakers;
  private rateLimiters;
  private compressionEnabled;
  private customIdGenerator?;
  constructor(io: SocketIOServer, container: Container);
  private setupAdvancedFeatures;
  setCustomIdGenerator(generator: () => string): void;
  enableCompression(options?: {
    threshold?: number;
    concurrencyLimit?: number;
    memLevel?: number;
  }): void;
  private processBinaryData;
  private shouldCompress;
  registerHandler(
    namespace: Namespace,
    wsConfig: WebSocketDefinition,
    moduleConfig: ModuleConfig
  ): Promise<void>;
  private setupSocketHandlers;
  private setupSocketMiddleware;
  private checkRateLimit;
  private getCircuitBreaker;
  private cleanup;
}
