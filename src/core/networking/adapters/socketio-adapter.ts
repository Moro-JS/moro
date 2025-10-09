// Socket.IO WebSocket Adapter for Moro Framework
// Implements the WebSocket adapter interface using Socket.IO

import { resolveUserPackage } from '../../utilities/package-utils.js';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
} from '../websocket-adapter.js';

/**
 * Socket.IO adapter implementation
 */
export class SocketIOAdapter implements WebSocketAdapter {
  private io: any; // Socket.IO server instance
  private customIdGenerator?: () => string;

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    try {
      // Dynamic import from user's context to find their installed socket.io
      const socketIOPath = resolveUserPackage('socket.io');
      const { Server } = await import(socketIOPath);

      this.io = new Server(httpServer, {
        cors: options.cors || { origin: '*' },
        path: options.path || '/socket.io/',
        compression: options.compression !== false,
        maxHttpBufferSize: options.maxPayloadLength,
        ...options,
      });

      // Apply custom ID generator if set
      if (this.customIdGenerator) {
        (this.io.engine as any).generateId = this.customIdGenerator;
      }

      // Setup compression if enabled
      if (options.compression) {
        this.setCompression(true);
      }
    } catch (error) {
      throw new Error(
        'Socket.IO not found. Install it with: npm install socket.io\n' +
          'Or use a different WebSocket adapter.'
      );
    }
  }

  createNamespace(namespace: string): WebSocketNamespace {
    if (!this.io) {
      throw new Error('Socket.IO adapter not initialized');
    }

    const ns = this.io.of(namespace);
    return new SocketIONamespaceWrapper(ns);
  }

  getDefaultNamespace(): WebSocketNamespace {
    return this.createNamespace('/');
  }

  async close(): Promise<void> {
    if (this.io) {
      return new Promise(resolve => {
        this.io.close(() => resolve());
      });
    }
  }

  setCompression(enabled: boolean, options: any = {}): void {
    if (this.io && enabled) {
      (this.io.engine as any).compression = true;
      (this.io.engine as any).perMessageDeflate = {
        threshold: 1024,
        concurrencyLimit: 10,
        memLevel: 8,
        ...options,
      };
    }
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
    if (this.io) {
      (this.io.engine as any).generateId = generator;
    }
  }

  getAdapterName(): string {
    return 'socket.io';
  }

  getConnectionCount(): number {
    if (!this.io) return 0;
    return this.io.engine.clientsCount || 0;
  }
}

/**
 * Socket.IO namespace wrapper
 */
class SocketIONamespaceWrapper implements WebSocketNamespace {
  constructor(private namespace: any) {}

  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void {
    this.namespace.on(event, (socket: any) => {
      handler(new SocketIOConnectionWrapper(socket));
    });
  }

  emit(event: string, data: any): void {
    this.namespace.emit(event, data);
  }

  to(room: string | string[]): WebSocketEmitter {
    const target = Array.isArray(room)
      ? room.reduce((acc, r) => acc.to(r), this.namespace)
      : this.namespace.to(room);
    return new SocketIOEmitterWrapper(target);
  }

  except(room: string | string[]): WebSocketEmitter {
    const target = Array.isArray(room)
      ? room.reduce((acc, r) => acc.except(r), this.namespace)
      : this.namespace.except(room);
    return new SocketIOEmitterWrapper(target);
  }

  getSockets(): WebSocketConnection[] {
    const sockets = this.namespace.sockets;
    return Array.from(sockets.values()).map((socket: any) => new SocketIOConnectionWrapper(socket));
  }

  getConnectionCount(): number {
    return this.namespace.sockets.size;
  }

  use(middleware: WebSocketMiddleware): void {
    this.namespace.use((socket: any, next: any) => {
      middleware(new SocketIOConnectionWrapper(socket), next);
    });
  }
}

/**
 * Socket.IO connection wrapper
 */
class SocketIOConnectionWrapper implements WebSocketConnection {
  public data: Record<string, any> = {};

  constructor(private socket: any) {
    // Map socket.data to our data property
    this.data = socket.data || {};
  }

  get id(): string {
    return this.socket.id;
  }

  get ip(): string | undefined {
    return this.socket.handshake?.address;
  }

  get headers(): Record<string, string> | undefined {
    return this.socket.handshake?.headers;
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  get broadcast(): WebSocketEmitter {
    return new SocketIOEmitterWrapper(this.socket.broadcast);
  }

  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void {
    this.socket.on(event, handler);
  }

  onAny(handler: (event: string, ...args: any[]) => void): void {
    this.socket.onAny(handler);
  }

  emit(event: string, data: any): void {
    this.socket.emit(event, data);
  }

  compressedEmit(event: string, data: any): void {
    this.socket.compress(true).emit(event, data);
  }

  join(room: string | string[]): void {
    if (Array.isArray(room)) {
      room.forEach(r => this.socket.join(r));
    } else {
      this.socket.join(room);
    }
  }

  leave(room: string | string[]): void {
    if (Array.isArray(room)) {
      room.forEach(r => this.socket.leave(r));
    } else {
      this.socket.leave(room);
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    const target = Array.isArray(room)
      ? room.reduce((acc, r) => acc.to(r), this.socket)
      : this.socket.to(room);
    return new SocketIOEmitterWrapper(target);
  }

  getRooms(): Set<string> {
    return new Set(this.socket.rooms);
  }

  disconnect(close?: boolean): void {
    this.socket.disconnect(close);
  }
}

/**
 * Socket.IO emitter wrapper
 */
class SocketIOEmitterWrapper implements WebSocketEmitter {
  constructor(private emitter: any) {}

  emit(event: string, data: any): void {
    this.emitter.emit(event, data);
  }

  to(room: string | string[]): WebSocketEmitter {
    const target = Array.isArray(room)
      ? room.reduce((acc, r) => acc.to(r), this.emitter)
      : this.emitter.to(room);
    return new SocketIOEmitterWrapper(target);
  }

  except(room: string | string[]): WebSocketEmitter {
    const target = Array.isArray(room)
      ? room.reduce((acc, r) => acc.except(r), this.emitter)
      : this.emitter.except(room);
    return new SocketIOEmitterWrapper(target);
  }

  compress(compress: boolean): WebSocketEmitter {
    return new SocketIOEmitterWrapper(this.emitter.compress(compress));
  }
}
