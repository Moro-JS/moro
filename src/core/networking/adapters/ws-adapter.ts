// Native WebSocket Adapter for Moro Framework
// Implements the WebSocket adapter interface using the 'ws' library

import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
} from '../websocket-adapter';
import { createFrameworkLogger } from '../../logger';

/**
 * Native WebSocket adapter using the 'ws' library
 * Provides a lightweight, standards-compliant WebSocket implementation
 */
export class WSAdapter implements WebSocketAdapter {
  private wss: any; // WebSocket server instance
  private namespaces = new Map<string, WSNamespaceWrapper>();
  private connections = new Map<string, WSConnectionWrapper>();
  private customIdGenerator?: () => string;
  private connectionCounter = 0;
  private wsLogger = createFrameworkLogger('WEBSOCKET_ADAPTER');

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    try {
      // Dynamic import to avoid requiring ws as a hard dependency
      const { WebSocketServer } = await import('ws');

      this.wss = new WebSocketServer({
        server: httpServer,
        path: options.path || '/ws',
        maxPayload: options.maxPayloadLength || 100 * 1024 * 1024, // 100MB default
        // Note: ws doesn't have built-in compression like socket.io
        // but browsers handle compression at the transport level
      });

      // Setup connection handling
      this.wss.on('connection', (ws: any, request: any) => {
        this.handleConnection(ws, request);
      });

      // Setup default namespace
      this.createNamespace('/');
    } catch (error) {
      throw new Error(
        'ws library not found. Install it with: npm install ws @types/ws\n' +
          'Or use a different WebSocket adapter.'
      );
    }
  }

  private handleConnection(ws: any, request: any): void {
    const id = this.generateId();
    const connection = new WSConnectionWrapper(id, ws, request);

    this.connections.set(id, connection);

    // Parse namespace from URL path or default to '/'
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    const namespacePath = url.pathname === '/ws' ? '/' : url.pathname.replace('/ws', '') || '/';

    const namespace = this.namespaces.get(namespacePath);
    if (namespace) {
      namespace.handleConnection(connection);
    }

    // Clean up on disconnect
    ws.on('close', () => {
      this.connections.delete(id);
    });
  }

  createNamespace(namespace: string): WebSocketNamespace {
    if (!this.namespaces.has(namespace)) {
      const ns = new WSNamespaceWrapper(namespace, this);
      this.namespaces.set(namespace, ns);
    }
    return this.namespaces.get(namespace)!;
  }

  getDefaultNamespace(): WebSocketNamespace {
    return this.createNamespace('/');
  }

  async close(): Promise<void> {
    if (this.wss) {
      return new Promise(resolve => {
        this.wss.close(() => {
          this.connections.clear();
          this.namespaces.clear();
          resolve();
        });
      });
    }
  }

  setCompression(enabled: boolean, _options: any = {}): void {
    // ws library handles compression at the browser level
    // This is a no-op but kept for interface compatibility
    if (enabled) {
      this.wsLogger.warn(
        'Compression is handled automatically by the ws library and browsers',
        'WSAdapter'
      );
    }
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
  }

  getAdapterName(): string {
    return 'ws';
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  generateId(): string {
    if (this.customIdGenerator) {
      return this.customIdGenerator();
    }
    return `ws_${++this.connectionCounter}_${Date.now()}`;
  }

  addConnection(id: string, connection: WSConnectionWrapper): void {
    this.connections.set(id, connection);
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  getAllConnections(): Map<string, WSConnectionWrapper> {
    return this.connections;
  }
}

/**
 * WebSocket namespace wrapper
 */
class WSNamespaceWrapper implements WebSocketNamespace {
  private connectionHandlers: ((socket: WebSocketConnection) => void)[] = [];
  private middlewares: WebSocketMiddleware[] = [];
  private connections = new Map<string, WSConnectionWrapper>();

  constructor(
    private namespacePath: string,
    private adapter: WSAdapter
  ) {}

  handleConnection(connection: WSConnectionWrapper): void {
    this.connections.set(connection.id, connection);

    // Run middlewares
    this.runMiddlewares(connection, () => {
      // Notify connection handlers
      this.connectionHandlers.forEach(handler => handler(connection));
    });

    // Clean up on disconnect
    connection.on('close', () => {
      this.connections.delete(connection.id);
    });
  }

  private runMiddlewares(connection: WSConnectionWrapper, callback: () => void): void {
    let index = 0;

    const next = (err?: Error) => {
      if (err || index >= this.middlewares.length) {
        if (!err) callback();
        return;
      }

      const middleware = this.middlewares[index++];
      middleware(connection, next);
    };

    next();
  }

  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void {
    this.connectionHandlers.push(handler);
  }

  emit(event: string, data: any): void {
    const message = JSON.stringify({ event, data });
    for (const connection of this.connections.values()) {
      if (connection.connected) {
        connection.ws.send(message);
      }
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new WSEmitterWrapper(this.connections, room);
  }

  except(room: string | string[]): WebSocketEmitter {
    return new WSEmitterWrapper(this.connections, undefined, room);
  }

  getSockets(): WebSocketConnection[] {
    return Array.from(this.connections.values());
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  use(middleware: WebSocketMiddleware): void {
    this.middlewares.push(middleware);
  }
}

/**
 * WebSocket connection wrapper
 */
class WSConnectionWrapper implements WebSocketConnection {
  public data: Record<string, any> = {};
  private eventHandlers = new Map<string, Function[]>();
  private anyHandlers: Function[] = [];
  private rooms = new Set<string>();
  private _connected = true;

  constructor(
    public readonly id: string,
    public readonly ws: any,
    private request: any
  ) {
    // Setup message handling
    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(data);
    });

    this.ws.on('close', () => {
      this._connected = false;
      this.emit('close');
    });

    this.ws.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  get ip(): string | undefined {
    return (
      this.request.socket?.remoteAddress || this.request.headers['x-forwarded-for']?.split(',')[0]
    );
  }

  get headers(): Record<string, string> | undefined {
    return this.request.headers;
  }

  get connected(): boolean {
    return this._connected && this.ws.readyState === 1; // WebSocket.OPEN
  }

  get broadcast(): WebSocketEmitter {
    // Get all connections except this one
    const allConnections = new Map();
    // This would need access to adapter's connections
    return new WSEmitterWrapper(allConnections, undefined, undefined, this.id);
  }

  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void {
    if (event === 'close' || event === 'error') {
      // Special internal events
      if (!this.eventHandlers.has(event)) {
        this.eventHandlers.set(event, []);
      }
      this.eventHandlers.get(event)!.push(handler);
      return;
    }

    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  onAny(handler: (event: string, ...args: any[]) => void): void {
    this.anyHandlers.push(handler);
  }

  emit(event: string, data?: any): void {
    if (event === 'close' || event === 'error') {
      // Internal events
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        handlers.forEach(handler => handler(data));
      }
      return;
    }

    if (this.connected) {
      const message = JSON.stringify({ event, data });
      this.ws.send(message);
    }
  }

  compressedEmit(event: string, data: any): void {
    // ws library handles compression automatically
    this.emit(event, data);
  }

  join(room: string | string[]): void {
    if (Array.isArray(room)) {
      room.forEach(r => this.rooms.add(r));
    } else {
      this.rooms.add(room);
    }
  }

  leave(room: string | string[]): void {
    if (Array.isArray(room)) {
      room.forEach(r => this.rooms.delete(r));
    } else {
      this.rooms.delete(room);
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    const connections = new Map([[this.id, this]]);
    return new WSEmitterWrapper(connections, room);
  }

  getRooms(): Set<string> {
    return new Set(this.rooms);
  }

  disconnect(close?: boolean): void {
    if (close !== false && this.ws.readyState === 1) {
      this.ws.close();
    }
    this._connected = false;
  }

  private handleMessage(data: Buffer): void {
    try {
      const text = data.toString();
      const parsed = JSON.parse(text);
      const { event, data: messageData, callback: callbackId } = parsed;

      // Create callback function if callback ID is provided
      const callback = callbackId
        ? (response: any) => {
            this.emit('callback', { id: callbackId, data: response });
          }
        : undefined;

      // Call any handlers
      this.anyHandlers.forEach(handler => handler(event, messageData));

      // Call specific event handlers
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        handlers.forEach(handler => handler(messageData, callback));
      }
    } catch (error) {
      // Invalid message format - ignore
    }
  }
}

/**
 * WebSocket emitter wrapper
 */
class WSEmitterWrapper implements WebSocketEmitter {
  constructor(
    private connections: Map<string, WSConnectionWrapper>,
    private targetRooms?: string | string[],
    private excludeRooms?: string | string[],
    private excludeId?: string
  ) {}

  emit(event: string, data: any): void {
    const message = JSON.stringify({ event, data });

    for (const connection of this.connections.values()) {
      if (this.excludeId && connection.id === this.excludeId) {
        continue;
      }

      if (this.shouldIncludeConnection(connection) && connection.connected) {
        connection.ws.send(message);
      }
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new WSEmitterWrapper(this.connections, room, this.excludeRooms, this.excludeId);
  }

  except(room: string | string[]): WebSocketEmitter {
    return new WSEmitterWrapper(this.connections, this.targetRooms, room, this.excludeId);
  }

  compress(_compress: boolean): WebSocketEmitter {
    // ws library handles compression automatically
    return this;
  }

  private shouldIncludeConnection(connection: WSConnectionWrapper): boolean {
    const rooms = connection.getRooms();

    // Check target rooms
    if (this.targetRooms) {
      const targets = Array.isArray(this.targetRooms) ? this.targetRooms : [this.targetRooms];
      if (!targets.some(room => rooms.has(room))) {
        return false;
      }
    }

    // Check exclude rooms
    if (this.excludeRooms) {
      const excludes = Array.isArray(this.excludeRooms) ? this.excludeRooms : [this.excludeRooms];
      if (excludes.some(room => rooms.has(room))) {
        return false;
      }
    }

    return true;
  }
}
