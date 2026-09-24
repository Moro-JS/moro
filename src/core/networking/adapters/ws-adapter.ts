// Native WebSocket Adapter for Moro Framework
// Implements the WebSocket adapter interface using the 'ws' library

import { resolveUserPackage } from '../../utilities/package-utils.js';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketNamespaceOptions,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
} from '../websocket-adapter.js';
import { createFrameworkLogger } from '../../logger/index.js';

/**
 * Native WebSocket adapter using the 'ws' library
 * Provides a lightweight, standards-compliant WebSocket implementation
 */
export class WSAdapter implements WebSocketAdapter {
  private wss: any; // WebSocket server instance
  private namespaces = new Map<string, WSNamespaceWrapper>();
  private connections = new Map<string, WSConnectionWrapper>();
  private wsLogger = createFrameworkLogger('WEBSOCKET_ADAPTER');
  private customIdGenerator?: () => string;
  private connectionCounter = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval> | undefined;
  /** Upgrade path prefix (options.path, default '/ws'): namespaces live below it */
  private basePath = '/ws';
  private httpServer: any;
  private upgradeHandler: ((req: any, socket: any, head: Buffer) => void) | undefined;

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    try {
      // Dynamic import from user's context to find their installed ws library
      const wsPath = resolveUserPackage('ws');
      const { WebSocketServer } = await import(wsPath);

      // `ws` matches its `path` option EXACTLY, which would confine every
      // namespace to the one base path. Namespaces are routed by URL
      // (`/ws/chat` -> '/chat'), so the adapter owns the upgrade step itself
      // and accepts the base path and anything below it. handleUpgrade()
      // still applies verifyClient and maxPayload exactly as server mode did.
      const base = (options.path || '/ws').replace(/\/+$/, '') || '/';
      this.basePath = base.startsWith('/') ? base : `/${base}`;
      this.wss = new WebSocketServer({
        noServer: true,
        // Matches the ws library's own default (100 MiB) so behavior is
        // unchanged; apps concerned about per-message buffering can lower it
        // via maxPayloadLength.
        maxPayload: options.maxPayloadLength || 100 * 1024 * 1024,
        // Origin allowlist + optional custom upgrade-auth hook. Without this a
        // cookie-authenticated app is open to cross-site WebSocket hijacking:
        // the browser sends auth cookies on a ws:// upgrade from any page.
        verifyClient: this.buildVerifyClient(options),
        // Note: ws doesn't have built-in compression like socket.io
        // but browsers handle compression at the transport level
      });

      this.httpServer = httpServer;
      this.upgradeHandler = (req: any, socket: any, head: Buffer) => {
        const pathname = String(req.url || '/').split('?')[0] ?? '/';
        const ours =
          this.basePath === '/' ||
          pathname === this.basePath ||
          pathname.startsWith(`${this.basePath}/`);
        if (!ours) {
          // Not this adapter's path. Another 'upgrade' listener may claim the
          // socket; with none, Node would leave it hanging, so answer and close.
          if (httpServer.listenerCount('upgrade') <= 1) {
            socket.write(
              'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
            );
            socket.destroy();
          }
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws: any) => {
          this.wss.emit('connection', ws, req);
        });
      };
      httpServer.on('upgrade', this.upgradeHandler);

      // Setup connection handling
      this.wss.on('connection', (ws: any, request: any) => {
        this.handleConnection(ws, request);
      });

      // Protocol-level ping/pong dead-peer detection: terminate half-open
      // sockets that stop answering so they neither leak nor block close().
      const heartbeatMs =
        options.idleTimeout && options.idleTimeout > 0 ? options.idleTimeout : 30000;
      this.heartbeatTimer = setInterval(() => {
        for (const ws of this.wss.clients) {
          if (ws.isAlive === false) {
            ws.terminate();
            continue;
          }
          ws.isAlive = false;
          try {
            ws.ping();
          } catch {
            // socket already going away
          }
        }
      }, heartbeatMs);
      this.heartbeatTimer.unref?.();

      // Setup default namespace
      this.createNamespace('/');
    } catch {
      throw new Error(
        'ws library not found. Install it with: npm install ws @types/ws\n' +
          'Or use a different WebSocket adapter.'
      );
    }
  }

  /**
   * Build a `ws` verifyClient callback enforcing the configured CORS origin
   * allowlist and any user-supplied upgrade-auth hook (`options.verifyClient`).
   *
   * `cors.origin` accepts:
   *   - undefined / true / '*'  -> allow any origin (permissive, back-compat)
   *   - false                   -> same-origin only
   *   - string                  -> that exact origin
   *   - string[]                -> any origin in the list
   *   - (requestOrigin) => ...  -> dynamic: return true (allow), false (deny),
   *                                '*' (allow), or the allowed origin string
   *                                (allowed when it equals the request origin).
   */
  private buildVerifyClient(
    options: WebSocketAdapterOptions
  ): ((info: { origin?: string; req: any; secure: boolean }) => boolean) | undefined {
    const corsOrigin = options.cors?.origin;
    const userVerify =
      typeof (options as any).verifyClient === 'function'
        ? ((options as any).verifyClient as (info: any) => boolean)
        : undefined;

    // Allow-all cases need no enforcement at all.
    const allowAll = corsOrigin === undefined || corsOrigin === true || corsOrigin === '*';
    if (allowAll && !userVerify) {
      return undefined;
    }

    return (info: { origin?: string; req: any; secure: boolean }): boolean => {
      // allowAll (undefined/true/'*') is handled above; here corsOrigin is a
      // specific rule to enforce.
      if (!allowAll) {
        const origin = info.origin;
        let ok = false;
        if (corsOrigin === false) {
          // Same-origin only: no Origin header (non-browser client) or the
          // Origin host equals the request Host.
          if (!origin) {
            ok = true;
          } else {
            try {
              const host = info.req?.headers?.host;
              ok = !!host && new URL(origin).host === host;
            } catch {
              ok = false;
            }
          }
        } else if (typeof corsOrigin === 'function') {
          // Dynamic: allow based on the function's decision for this origin.
          const decision = (corsOrigin as (o: string | undefined) => boolean | string)(origin);
          ok = decision === true || decision === '*' || (!!origin && decision === origin);
        } else if (corsOrigin instanceof RegExp) {
          ok = !!origin && corsOrigin.test(origin);
        } else if (typeof corsOrigin === 'string') {
          ok = origin === corsOrigin;
        } else if (Array.isArray(corsOrigin)) {
          ok = !!origin && corsOrigin.includes(origin);
        }
        if (!ok) {
          this.wsLogger.warn(
            `Rejected WebSocket upgrade from disallowed origin: ${origin ?? '(none)'}`
          );
          return false;
        }
      }
      return userVerify ? userVerify(info) : true;
    };
  }

  private handleConnection(ws: any, request: any): void {
    const id = this.generateId();
    const connection = new WSConnectionWrapper(id, ws, request);

    // Liveness tracking for the heartbeat sweep (see initialize()).
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    this.connections.set(id, connection);

    // Namespace = the URL path below the base path ('/ws/chat' -> '/chat');
    // the base path itself, and any path without a registered namespace,
    // land on the default namespace (engine-adapter parity).
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    let namespacePath = '/';
    if (this.basePath === '/') {
      namespacePath = url.pathname || '/';
    } else if (url.pathname.startsWith(`${this.basePath}/`)) {
      namespacePath = url.pathname.slice(this.basePath.length) || '/';
    }

    const namespace = this.namespaces.get(namespacePath) ?? this.namespaces.get('/');
    if (namespace) {
      connection.raw = namespace.raw;
      namespace.handleConnection(connection);
    }

    // Clean up on disconnect
    ws.on('close', () => {
      this.connections.delete(id);
    });
  }

  createNamespace(namespace: string, options?: WebSocketNamespaceOptions): WebSocketNamespace {
    if (!this.namespaces.has(namespace)) {
      const ns = new WSNamespaceWrapper(namespace, this);
      this.namespaces.set(namespace, ns);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ns = this.namespaces.get(namespace)!;
    if (options?.raw) ns.raw = true;
    return ns;
  }

  getDefaultNamespace(): WebSocketNamespace {
    return this.createNamespace('/');
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off?.('upgrade', this.upgradeHandler);
      this.upgradeHandler = undefined;
    }
    if (this.wss) {
      // Terminate live clients first: wss.close() only stops accepting new
      // connections and does not resolve while sockets remain open, which would
      // otherwise stall the app's graceful shutdown until its timeout.
      for (const ws of this.wss.clients) {
        try {
          ws.terminate();
        } catch {
          // socket already going away
        }
      }
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
      this.wsLogger.warn('Compression is handled automatically by the ws library and browsers');
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
  /** Raw framing for connections routed here (see WebSocketNamespaceOptions) */
  raw = false;
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
      // Notify connection handlers - optimized with for loop
      const handlers = this.connectionHandlers;
      const len = handlers.length;
      for (let i = 0; i < len; i++) {
        handlers[i]?.(connection);
      }
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
      middleware?.(connection, next);
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
  /** Raw framing (set from the namespace at connection) */
  public raw = false;
  private eventHandlers = new Map<string, CallableFunction[]>();
  private anyHandlers: CallableFunction[] = [];
  private rooms = new Set<string>();
  private _connected = true;

  constructor(
    public readonly id: string,
    public readonly ws: any,
    private request: any
  ) {
    // Setup message handling
    this.ws.on('message', (data: Buffer, isBinary?: boolean) => {
      this.handleMessage(data, isBinary === true);
    });

    this.ws.on('close', (code?: number, reason?: Buffer) => {
      this._connected = false;
      this.emit('close');
      // The documented `disconnect` hook (app.websocket({ disconnect })) - a
      // client-facing frame makes no sense on a closed socket, so it is
      // dispatched locally with the close code, like the engine adapter.
      const handlers = this.eventHandlers.get('disconnect');
      if (handlers) {
        const detail = { code, reason: reason ? reason.toString() : '' };
        for (let i = 0; i < handlers.length; i++) handlers[i]?.(detail);
      }
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.eventHandlers.get(event)!.push(handler);
      return;
    }

    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
        const len = handlers.length;
        for (let i = 0; i < len; i++) {
          handlers[i]?.(data);
        }
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
      const len = room.length;
      for (let i = 0; i < len; i++) {
        this.rooms.add(room[i] as string);
      }
    } else {
      this.rooms.add(room);
    }
  }

  leave(room: string | string[]): void {
    if (Array.isArray(room)) {
      const len = room.length;
      for (let i = 0; i < len; i++) {
        this.rooms.delete(room[i] as string);
      }
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

  send(data: string | Buffer | ArrayBuffer | Uint8Array, isBinary?: boolean): void {
    if (!this._connected || this.ws.readyState !== 1) return;
    this.ws.send(data, { binary: isBinary ?? typeof data !== 'string' });
  }

  private handleMessage(data: Buffer, isBinary = false): void {
    if (this.raw) {
      // Raw namespace: no envelope. Text -> 'message' (string), binary ->
      // 'binary' (Buffer; ws may hand over a Buffer[] for fragmented frames).
      const event = isBinary ? 'binary' : 'message';
      const payload = isBinary
        ? Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as any)
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : data.toString();
      for (const any of this.anyHandlers) any(event, payload);
      const handlers = this.eventHandlers.get(event);
      if (handlers) for (const handler of handlers) handler(payload);
      return;
    }
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

      // Call any handlers - optimized with for loop
      const anyHandlers = this.anyHandlers;
      const anyLen = anyHandlers.length;
      for (let i = 0; i < anyLen; i++) {
        anyHandlers[i]?.(event, messageData);
      }

      // Call specific event handlers - optimized with for loop
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        const len = handlers.length;
        for (let i = 0; i < len; i++) {
          handlers[i]?.(messageData, callback);
        }
      }
    } catch {
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

    // Check target rooms - avoid array wrapping and use efficient iteration
    if (this.targetRooms) {
      if (Array.isArray(this.targetRooms)) {
        let hasTargetRoom = false;
        const len = this.targetRooms.length;
        for (let i = 0; i < len; i++) {
          if (rooms.has(this.targetRooms[i] as string)) {
            hasTargetRoom = true;
            break;
          }
        }
        if (!hasTargetRoom) return false;
      } else {
        if (!rooms.has(this.targetRooms)) return false;
      }
    }

    // Check exclude rooms - avoid array wrapping and use efficient iteration
    if (this.excludeRooms) {
      if (Array.isArray(this.excludeRooms)) {
        const len = this.excludeRooms.length;
        for (let i = 0; i < len; i++) {
          if (rooms.has(this.excludeRooms[i] as string)) return false;
        }
      } else {
        if (rooms.has(this.excludeRooms)) return false;
      }
    }

    return true;
  }
}
