// WebSocket Manager for Moro Framework
// Manages WebSocket connections using pluggable adapters
import * as zlib from 'zlib';
import { Container } from '../utilities/index.js';
import { CircuitBreaker } from '../utilities/index.js';
import { ModuleConfig, WebSocketDefinition } from '../../types/module.js';
import { WebSocketAdapter, WebSocketNamespace, WebSocketConnection } from './websocket-adapter.js';
import { createFrameworkLogger } from '../logger/index.js';
import { normalizeValidationError } from '../validation/schema-interface.js';

export class WebSocketManager {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private rateLimiters = new Map<string, Map<string, { count: number; resetTime: number }>>();
  private logger = createFrameworkLogger('WebSocketManager');

  constructor(
    private adapter: WebSocketAdapter,
    private container: Container
  ) {
    this.logger.info(`Initialized with ${adapter.getAdapterName()} adapter`, 'AdapterInit');
  }

  /**
   * Set custom ID generator for the adapter
   */
  setCustomIdGenerator(generator: () => string): void {
    this.adapter.setCustomIdGenerator(generator);
  }

  /**
   * Enable compression for the adapter
   */
  enableCompression(options?: any): void {
    this.adapter.setCompression(true, options);
  }

  /**
   * Get the underlying adapter
   */
  getAdapter(): WebSocketAdapter {
    return this.adapter;
  }

  /**
   * Get connection count across all namespaces
   */
  getConnectionCount(): number {
    return this.adapter.getConnectionCount();
  }

  /**
   * Create or get a namespace
   */
  getNamespace(namespace: string): WebSocketNamespace {
    return this.adapter.createNamespace(namespace);
  }

  /**
   * Register WebSocket handlers for a module
   */
  async registerHandler(
    namespace: WebSocketNamespace,
    wsConfig: WebSocketDefinition,
    moduleConfig: ModuleConfig
  ): Promise<void> {
    namespace.on('connection', (socket: WebSocketConnection) => {
      this.logger.debug(`New connection: ${socket.id}`, 'Connection', {
        namespace: namespace.constructor.name,
        module: moduleConfig.name,
      });

      this.setupSocketMiddleware(socket, moduleConfig.name);
      this.setupSocketHandlers(socket, wsConfig, moduleConfig);
    });
  }

  /**
   * Setup socket-specific middleware
   */
  private setupSocketMiddleware(socket: WebSocketConnection, moduleName: string): void {
    // Add module context to socket data
    socket.data.module = moduleName;
    socket.data.connectedAt = Date.now();

    // Setup heartbeat if supported
    if (socket.compressedEmit) {
      const heartbeatInterval = setInterval(() => {
        if (socket.connected) {
          socket.emit('heartbeat', { timestamp: Date.now() });
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 30000); // 30 seconds

      socket.on('disconnect', () => {
        clearInterval(heartbeatInterval);
      });
    }

    // Log disconnection
    socket.on('disconnect', () => {
      this.logger.debug(`Socket disconnected: ${socket.id}`, 'Disconnect', {
        module: moduleName,
        duration: Date.now() - socket.data.connectedAt,
      });
    });
  }

  /**
   * Setup handlers for a specific WebSocket configuration
   */
  private setupSocketHandlers(
    socket: WebSocketConnection,
    wsConfig: WebSocketDefinition,
    moduleConfig: ModuleConfig
  ): void {
    socket.on(wsConfig.event, async (data: any, callback?: CallableFunction) => {
      const handlerKey = `${moduleConfig.name}.${wsConfig.handler}`;

      try {
        // Rate limiting
        if (wsConfig.rateLimit && !this.checkRateLimit(socket.id, handlerKey, wsConfig.rateLimit)) {
          const error = {
            success: false,
            error: 'Rate limit exceeded',
            code: 'RATE_LIMIT',
          };
          if (callback) callback(error);
          else socket.emit('error', error);
          return;
        }

        // Universal validation (works with any ValidationSchema)
        if (wsConfig.validation) {
          try {
            data = await wsConfig.validation.parseAsync(data);
          } catch (validationError: any) {
            // Handle universal validation errors
            const normalizedError = normalizeValidationError(validationError);
            const error = {
              success: false,
              error: 'Validation failed',
              details: normalizedError.issues.map((issue: any) => ({
                field: issue.path.length > 0 ? issue.path.join('.') : 'data',
                message: issue.message,
                code: issue.code,
              })),
            };
            if (callback) callback(error);
            else socket.emit('error', error);
            return;
          }
        }

        // Circuit breaker protection
        const circuitBreaker = this.getCircuitBreaker(handlerKey);

        const result = await circuitBreaker.execute(async () => {
          const controller = this.container.resolve(moduleConfig.name);
          return await (controller as any)[wsConfig.handler](socket, data);
        });

        // Handle response
        if (callback) {
          callback({ success: true, data: result });
        } else if (result !== undefined) {
          socket.emit(`${wsConfig.event}:response`, { success: true, data: result });
        }

        // Handle room operations
        if (wsConfig.rooms) {
          wsConfig.rooms.forEach(room => socket.join(room));
        }

        // Handle broadcasting
        if (wsConfig.broadcast && result !== undefined) {
          socket.broadcast.emit(wsConfig.event, { success: true, data: result });
        }
      } catch (error) {
        this.logger.error('WebSocket handler error', 'HandlerError', {
          handler: handlerKey,
          error: error instanceof Error ? error.message : String(error),
          socketId: socket.id,
        });

        const errorResponse = {
          success: false,
          error: 'Internal server error',
          code: 'HANDLER_ERROR',
        };

        if (callback) callback(errorResponse);
        else socket.emit('error', errorResponse);
      }
    });
  }

  /**
   * Get or create circuit breaker for handler
   */
  private getCircuitBreaker(handlerKey: string): CircuitBreaker {
    if (!this.circuitBreakers.has(handlerKey)) {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 5,
        resetTimeout: 60000,
        monitoringPeriod: 10000,
      });
      this.circuitBreakers.set(handlerKey, circuitBreaker);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.circuitBreakers.get(handlerKey)!;
  }

  /**
   * Check rate limit for socket and handler
   */
  private checkRateLimit(
    socketId: string,
    handlerKey: string,
    rateLimit: { requests: number; window: number }
  ): boolean {
    if (!this.rateLimiters.has(handlerKey)) {
      this.rateLimiters.set(handlerKey, new Map());
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const handlerLimiter = this.rateLimiters.get(handlerKey)!;
    const now = Date.now();
    const windowStart = now - rateLimit.window;

    // Clean old entries
    for (const [id, data] of handlerLimiter.entries()) {
      if (data.resetTime < windowStart) {
        handlerLimiter.delete(id);
      }
    }

    // Check current socket
    const socketData = handlerLimiter.get(socketId);
    if (!socketData) {
      handlerLimiter.set(socketId, { count: 1, resetTime: now });
      return true;
    }

    if (socketData.resetTime < windowStart) {
      socketData.count = 1;
      socketData.resetTime = now;
      return true;
    }

    if (socketData.count >= rateLimit.requests) {
      return false;
    }

    socketData.count++;
    return true;
  }

  /**
   * Process binary data efficiently
   */
  private processBinaryData(buffer: Buffer): any {
    // Example binary processing - can be extended based on needs
    if (buffer.length === 0) return buffer;

    // Simple compression check
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      // This is gzipped data
      try {
        return zlib.gunzipSync(buffer);
      } catch {
        return buffer;
      }
    }

    return buffer;
  }

  /**
   * Check if data should be compressed
   */
  private shouldCompress(data: any): boolean {
    if (typeof data === 'string') {
      return data.length > 1024;
    }
    if (Buffer.isBuffer(data)) {
      return data.length > 1024;
    }
    if (typeof data === 'object') {
      return JSON.stringify(data).length > 1024;
    }
    return false;
  }

  /**
   * Close the WebSocket manager and underlying adapter
   */
  async close(): Promise<void> {
    this.logger.info('Closing WebSocket manager', 'Shutdown');

    // Clear rate limiters
    this.rateLimiters.clear();

    // Clear circuit breakers
    this.circuitBreakers.clear();

    // Close adapter
    await this.adapter.close();
  }
}
