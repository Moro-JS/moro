// uWebSockets Adapter for Moro Framework
// Implements the WebSocket adapter interface using uWebSockets.js
// High-performance C++ WebSocket implementation with native Node.js bindings

import { resolveUserPackage } from '../../utilities/package-utils.js';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
} from '../websocket-adapter.js';
import { createFrameworkLogger } from '../../logger/index.js';

/**
 * uWebSockets adapter implementation
 * Provides high-performance WebSocket support using uWebSockets.js
 */
export class UWebSocketsAdapter implements WebSocketAdapter {
  private app: any; // uWebSockets app instance
  private uws: any; // uWebSockets module reference (stored to avoid re-importing)
  private listenSocket: any; // uWebSockets listen socket
  private namespaces = new Map<string, UWSNamespaceWrapper>();
  private connections = new Map<string, UWSConnectionWrapper>();
  private logger = createFrameworkLogger('UWS_ADAPTER');
  private customIdGenerator?: () => string;
  private connectionCounter = 0;
  private compressionEnabled = false;
  private compressionOptions: any = {};
  private httpServer: any; // Reference to Node.js HTTP server for compatibility

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    try {
      // Lazy load uWebSockets.js from user's context
      // This ensures it's an optional dependency with graceful fallback
      const uwsPath = resolveUserPackage('uWebSockets.js');
      this.uws = await import(uwsPath);

      // Store HTTP server reference for compatibility
      this.httpServer = httpServer;

      // uWebSockets.js doesn't integrate with Node's http.Server
      // Instead, it creates its own server, so we'll need to handle this carefully
      // We'll create a uWebSockets app that can coexist with the HTTP server

      // Check if SSL/TLS options are provided
      const sslOptions = (options as any).ssl;

      if (sslOptions && sslOptions.key_file_name && sslOptions.cert_file_name) {
        // Create SSL app
        this.app = this.uws.SSLApp({
          key_file_name: sslOptions.key_file_name,
          cert_file_name: sslOptions.cert_file_name,
          passphrase: sslOptions.passphrase,
          ...sslOptions,
        });
        this.logger.info('uWebSockets SSL/TLS app created', 'Init');
      } else {
        // Create regular app
        this.app = this.uws.App();
        this.logger.info('uWebSockets app created', 'Init');
      }

      // Setup WebSocket route with configurable path
      const wsPath = options.path || '/*';
      const maxPayloadLength = options.maxPayloadLength || 100 * 1024 * 1024; // 100MB default
      const idleTimeout = options.idleTimeout || 120; // 2 minutes default

      // Configure compression if enabled
      const compression = options.compression !== false;

      this.app.ws(wsPath, {
        // Compression settings - uWebSockets.js has built-in compression
        compression: compression ? 1 : 0, // 0 = disabled, 1 = shared compressor, 2 = dedicated compressor
        maxPayloadLength,
        idleTimeout,
        maxBackpressure: 1024 * 1024, // 1MB backpressure limit

        // Connection opened
        open: (ws: any) => {
          this.handleConnection(ws);
        },

        // Message received
        message: (ws: any, message: ArrayBuffer, isBinary: boolean) => {
          this.handleMessage(ws, message, isBinary);
        },

        // Connection closed
        close: (ws: any, code: number, message: ArrayBuffer) => {
          this.handleClose(ws, code, message);
        },

        // Drain handler for backpressure management
        drain: (ws: any) => {
          this.handleDrain(ws);
        },
      });

      // Setup default namespace
      this.createNamespace('/');

      this.logger.info('uWebSockets adapter initialized', 'Init');
    } catch (error) {
      // Throw helpful error with installation instructions
      throw new Error(
        'Failed to load uWebSockets.js (optional dependency)\n' +
          'To use the uWebSockets adapter, install it with:\n' +
          '  npm install --save-dev github:uNetworking/uWebSockets.js#v20.52.0\n' +
          'Or use a different WebSocket adapter (socket.io or ws) in your config.\n' +
          'Error: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * Start listening on a specific port
   * This is necessary because uWebSockets.js manages its own server
   */
  listen(port: number, callback?: (token: any) => void): void {
    if (!this.app) {
      throw new Error('uWebSockets app not initialized. Call initialize() first.');
    }

    this.app.listen(port, (token: any) => {
      if (token) {
        this.listenSocket = token;
        this.logger.info(`uWebSockets listening on port ${port}`, 'Listen');
        if (callback) callback(token);
      } else {
        this.logger.error(`Failed to listen on port ${port}`, 'Listen');
      }
    });
  }

  /**
   * Start listening on host and port
   */
  listenWithHost(host: string, port: number, callback?: (token: any) => void): void {
    if (!this.app) {
      throw new Error('uWebSockets app not initialized. Call initialize() first.');
    }

    this.app.listen(host, port, (token: any) => {
      if (token) {
        this.listenSocket = token;
        this.logger.info(`uWebSockets listening on ${host}:${port}`, 'Listen');
        if (callback) callback(token);
      } else {
        this.logger.error(`Failed to listen on ${host}:${port}`, 'Listen');
      }
    });
  }

  private handleConnection(ws: any): void {
    const id = this.generateId();

    // Extract connection info
    const ip = Buffer.from(ws.getRemoteAddressAsText()).toString();

    // Create connection wrapper
    const connection = new UWSConnectionWrapper(ws, id, ip, this.namespaces);
    this.connections.set(id, connection);

    // Store connection ID on the WebSocket for later retrieval
    ws.connectionId = id;

    // Notify default namespace of new connection
    const defaultNamespace = this.namespaces.get('/');
    if (defaultNamespace) {
      defaultNamespace.handleConnection(connection);
    }

    this.logger.debug(`WebSocket connection opened: ${id} from ${ip}`, 'Connection');
  }

  private handleMessage(ws: any, message: ArrayBuffer, _isBinary: boolean): void {
    const connectionId = ws.connectionId;
    const connection = this.connections.get(connectionId);

    if (!connection) {
      this.logger.warn(`Message received for unknown connection: ${connectionId}`, 'Message');
      return;
    }

    try {
      // Parse message - expect JSON format for compatibility with socket.io-like behavior
      const messageStr = Buffer.from(message).toString('utf-8');
      const data = JSON.parse(messageStr);

      // Handle message in connection wrapper
      connection.handleMessage(data);
    } catch (error) {
      this.logger.error(
        `Failed to parse message from ${connectionId}: ${error instanceof Error ? error.message : String(error)}`,
        'Message'
      );
    }
  }

  private handleClose(ws: any, code: number, message: ArrayBuffer): void {
    const connectionId = ws.connectionId;
    const connection = this.connections.get(connectionId);

    if (connection) {
      connection.handleClose(code, message);
      this.connections.delete(connectionId);
      this.logger.debug(`WebSocket connection closed: ${connectionId}`, 'Connection');
    }
  }

  private handleDrain(ws: any): void {
    // Handle backpressure drain event
    const connectionId = ws.connectionId;
    const connection = this.connections.get(connectionId);

    if (connection) {
      connection.handleDrain();
    }
  }

  private generateId(): string {
    if (this.customIdGenerator) {
      return this.customIdGenerator();
    }
    return `uws_${++this.connectionCounter}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  createNamespace(namespace: string): WebSocketNamespace {
    if (!this.namespaces.has(namespace)) {
      const ns = new UWSNamespaceWrapper(namespace, this.connections);
      this.namespaces.set(namespace, ns);
      this.logger.debug(`Created namespace: ${namespace}`, 'Namespace');
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.namespaces.get(namespace)!;
  }

  getDefaultNamespace(): WebSocketNamespace {
    return this.createNamespace('/');
  }

  async close(): Promise<void> {
    // Close all connections
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [id, connection] of this.connections) {
      connection.disconnect(true);
    }
    this.connections.clear();
    this.namespaces.clear();

    // Close the uWebSockets listen socket
    if (this.listenSocket && this.uws) {
      // Use stored module reference instead of re-importing
      this.uws.us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;
    }

    this.logger.info('uWebSockets adapter closed', 'Close');
  }

  setCompression(enabled: boolean, options?: any): void {
    this.compressionEnabled = enabled;
    this.compressionOptions = options || {};
    this.logger.debug(`Compression ${enabled ? 'enabled' : 'disabled'}`, 'Compression');
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
    this.logger.debug('Custom ID generator set', 'Config');
  }

  getAdapterName(): string {
    return 'uWebSockets.js';
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get the underlying uWebSockets app for advanced usage
   */
  getApp(): any {
    return this.app;
  }
}

/**
 * Namespace wrapper for uWebSockets
 */
class UWSNamespaceWrapper implements WebSocketNamespace {
  private connectionHandlers: ((socket: WebSocketConnection) => void)[] = [];
  private middlewares: WebSocketMiddleware[] = [];

  constructor(
    private namespace: string,
    private connections: Map<string, UWSConnectionWrapper>
  ) {}

  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void {
    if (event === 'connection') {
      this.connectionHandlers.push(handler);
    }
  }

  handleConnection(connection: UWSConnectionWrapper): void {
    // Run middlewares
    this.runMiddlewares(connection, err => {
      if (err) {
        connection.disconnect(true);
        return;
      }

      // Notify all connection handlers
      for (const handler of this.connectionHandlers) {
        handler(connection);
      }
    });
  }

  private runMiddlewares(
    connection: UWSConnectionWrapper,
    finalCallback: (err?: Error) => void
  ): void {
    let index = 0;

    const next = (err?: Error) => {
      if (err) {
        finalCallback(err);
        return;
      }

      if (index >= this.middlewares.length) {
        finalCallback();
        return;
      }

      const middleware = this.middlewares[index++];
      middleware(connection, next);
    };

    next();
  }

  emit(event: string, data: any): void {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [id, connection] of this.connections) {
      if (connection.connected) {
        connection.emit(event, data);
      }
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new UWSEmitterWrapper(this.connections, { rooms: Array.isArray(room) ? room : [room] });
  }

  except(room: string | string[]): WebSocketEmitter {
    return new UWSEmitterWrapper(this.connections, {
      exceptRooms: Array.isArray(room) ? room : [room],
    });
  }

  getSockets(): WebSocketConnection[] {
    return Array.from(this.connections.values()).filter(conn => conn.connected);
  }

  getConnectionCount(): number {
    return Array.from(this.connections.values()).filter(conn => conn.connected).length;
  }

  use(middleware: WebSocketMiddleware): void {
    this.middlewares.push(middleware);
  }
}

/**
 * Connection wrapper for uWebSockets
 */
class UWSConnectionWrapper implements WebSocketConnection {
  public data: Record<string, any> = {};
  public connected = true;
  private rooms = new Set<string>();
  private eventHandlers = new Map<
    string,
    Array<(data: any, callback?: (response?: any) => void) => void>
  >();
  private anyHandlers: Array<(event: string, ...args: any[]) => void> = [];
  private logger = createFrameworkLogger('UWS_CONNECTION');

  constructor(
    private ws: any,
    public readonly id: string,
    public readonly ip: string,
    private namespaces: Map<string, UWSNamespaceWrapper>
  ) {
    this.headers = this.parseHeaders();
  }

  public readonly headers: Record<string, string>;

  private parseHeaders(): Record<string, string> {
    // uWebSockets doesn't provide easy header access
    // We'll return empty headers for now, but this could be enhanced
    return {};
  }

  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.eventHandlers.get(event)!.push(handler);
  }

  onAny(handler: (event: string, ...args: any[]) => void): void {
    this.anyHandlers.push(handler);
  }

  emit(event: string, data: any): void {
    if (!this.connected) return;

    try {
      const message = JSON.stringify({ event, data });
      const buffer = Buffer.from(message);

      // Send message with backpressure handling
      const sent = this.ws.send(buffer, false); // false = not binary

      if (!sent) {
        this.logger.warn(`Backpressure detected for connection ${this.id}`, 'Backpressure');
      }
    } catch (error) {
      this.logger.error(
        `Failed to emit event ${event}: ${error instanceof Error ? error.message : String(error)}`,
        'Emit'
      );
    }
  }

  compressedEmit(event: string, data: any): void {
    // uWebSockets.js handles compression automatically based on app configuration
    // So this is the same as regular emit
    this.emit(event, data);
  }

  handleMessage(data: any): void {
    if (!data || typeof data !== 'object') {
      this.logger.warn(`Invalid message format from ${this.id}`, 'Message');
      return;
    }

    const { event, data: eventData, callback: hasCallback } = data;

    if (!event) {
      this.logger.warn(`Message without event from ${this.id}`, 'Message');
      return;
    }

    // Create callback function if client expects response
    const callback = hasCallback
      ? (response?: any) => {
          this.emit(`${event}:response`, response);
        }
      : undefined;

    // Notify any handlers
    for (const handler of this.anyHandlers) {
      handler(event, eventData);
    }

    // Notify specific event handlers
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(eventData, callback);
        } catch (error) {
          this.logger.error(
            `Error in event handler for ${event}: ${error instanceof Error ? error.message : String(error)}`,
            'Handler'
          );
        }
      }
    }
  }

  handleClose(code: number, _message: ArrayBuffer): void {
    this.connected = false;
    this.logger.debug(`Connection ${this.id} closed with code ${code}`, 'Close');
  }

  handleDrain(): void {
    // Backpressure has been relieved
    this.logger.debug(`Connection ${this.id} drained`, 'Drain');
  }

  join(room: string | string[]): void {
    const roomsToJoin = Array.isArray(room) ? room : [room];
    for (const r of roomsToJoin) {
      this.rooms.add(r);
      this.logger.debug(`Connection ${this.id} joined room ${r}`, 'Room');
    }
  }

  leave(room: string | string[]): void {
    const roomsToLeave = Array.isArray(room) ? room : [room];
    for (const r of roomsToLeave) {
      this.rooms.delete(r);
      this.logger.debug(`Connection ${this.id} left room ${r}`, 'Room');
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new UWSEmitterWrapper(new Map([[this.id, this]]), {
      rooms: Array.isArray(room) ? room : [room],
    });
  }

  get broadcast(): WebSocketEmitter {
    return new UWSEmitterWrapper(
      this.namespaces
        .get('/')
        ?.getSockets()
        .filter(s => s.id !== this.id)
        .reduce((map, conn) => {
          map.set(conn.id, conn as UWSConnectionWrapper);
          return map;
        }, new Map<string, UWSConnectionWrapper>()) || new Map(),
      {}
    );
  }

  getRooms(): Set<string> {
    return new Set(this.rooms);
  }

  disconnect(close = false): void {
    if (!this.connected) return;

    this.connected = false;

    if (close && this.ws) {
      try {
        this.ws.end(1000, 'Normal closure');
      } catch (error) {
        this.logger.error(
          `Error closing WebSocket: ${error instanceof Error ? error.message : String(error)}`,
          'Disconnect'
        );
      }
    }
  }
}

/**
 * Emitter wrapper for room-based broadcasting
 */
class UWSEmitterWrapper implements WebSocketEmitter {
  private targetRooms: string[] = [];
  private excludedRooms: string[] = [];
  private useCompression = false;

  constructor(
    private connections: Map<string, UWSConnectionWrapper>,
    private options: { rooms?: string[]; exceptRooms?: string[] } = {}
  ) {
    this.targetRooms = options.rooms || [];
    this.excludedRooms = options.exceptRooms || [];
  }

  emit(event: string, data: any): void {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [id, connection] of this.connections) {
      if (!connection.connected) continue;

      // Check room filtering
      const connectionRooms = connection.getRooms();

      // If target rooms specified, connection must be in at least one
      if (this.targetRooms.length > 0) {
        const inTargetRoom = this.targetRooms.some(room => connectionRooms.has(room));
        if (!inTargetRoom) continue;
      }

      // If excluded rooms specified, connection must not be in any
      if (this.excludedRooms.length > 0) {
        const inExcludedRoom = this.excludedRooms.some(room => connectionRooms.has(room));
        if (inExcludedRoom) continue;
      }

      // Emit to connection
      if (this.useCompression && connection.compressedEmit) {
        connection.compressedEmit(event, data);
      } else {
        connection.emit(event, data);
      }
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    const rooms = Array.isArray(room) ? room : [room];
    return new UWSEmitterWrapper(this.connections, {
      rooms: [...this.targetRooms, ...rooms],
      exceptRooms: this.excludedRooms,
    });
  }

  except(room: string | string[]): WebSocketEmitter {
    const rooms = Array.isArray(room) ? room : [room];
    return new UWSEmitterWrapper(this.connections, {
      rooms: this.targetRooms,
      exceptRooms: [...this.excludedRooms, ...rooms],
    });
  }

  compress(compress: boolean): WebSocketEmitter {
    this.useCompression = compress;
    return this;
  }
}
