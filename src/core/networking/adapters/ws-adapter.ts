// Native WebSocket Adapter for Moro Framework
// Implements the WebSocket adapter interface using the 'ws' library

import { randomUUID } from 'crypto';
import { resolveUserPackage } from '../../utilities/package-utils.js';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketNamespaceOptions,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
  ClientAddressResolver,
  originMatchesRule,
} from '../websocket-adapter.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { declineUnacceptableOffers, wsPerMessageDeflate } from './ws-deflate.js';

/** Largest accepted message when `maxPayloadLength` is not configured: 1 MiB. */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

/**
 * Events the adapter raises itself. Their handlers live apart from the
 * handlers for client events, and a frame naming one of them is dropped: a
 * client must not be able to run the server's `disconnect` / `close` / `error`
 * / `connection` hooks by sending that name.
 */
const LIFECYCLE_EVENTS: ReadonlySet<unknown> = new Set([
  'connection',
  'disconnect',
  'close',
  'error',
]);

const namespaceLogger = createFrameworkLogger('WEBSOCKET_ADAPTER');

const WS_NOT_FOUND_MESSAGE =
  'ws library not found. Install it with: npm install ws @types/ws\n' +
  'Or use a different WebSocket adapter.';

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

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
  private heartbeatTimer?: ReturnType<typeof setInterval> | undefined;
  /** Upgrade path prefix (options.path, default '/ws'): namespaces live below it */
  private basePath = '/ws';
  private httpServer: any;
  private upgradeHandler: ((req: any, socket: any, head: Buffer) => void) | undefined;
  /** Set when server.trustProxy is: who the client of a handshake is */
  private resolveClientAddress: ClientAddressResolver | undefined;
  /** setCompression(true) before initialize(): taken up there */
  private compressionRequested = false;
  /** The server was created with permessage-deflate */
  private compressionOn = false;
  private compressionWarned = false;

  /**
   * Load the WebSocketServer class from the application's `ws` install.
   *
   * `ws` is a CommonJS package whose exports are attached at runtime, so a
   * real ESM `import()` exposes them only on `default`; a CommonJS-compiled
   * build (and Jest) sees them as named exports. Both shapes are read.
   */
  private async loadWebSocketServer(): Promise<any> {
    let mod: any;
    try {
      // Dynamic import from user's context to find their installed ws library
      const wsPath = resolveUserPackage('ws');
      mod = await import(wsPath);
    } catch (error) {
      // Only a missing package is "not found"; anything else (a broken
      // install, a load-time error) keeps its own message.
      if (isModuleNotFound(error)) throw new Error(WS_NOT_FOUND_MESSAGE);
      throw error;
    }
    const WebSocketServer = mod?.WebSocketServer ?? mod?.default?.WebSocketServer;
    if (typeof WebSocketServer !== 'function') {
      throw new Error(
        "The installed 'ws' package does not export WebSocketServer (ws 8 or later is required)"
      );
    }
    return WebSocketServer;
  }

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    const WebSocketServer = await this.loadWebSocketServer();

    // `ws` matches its `path` option EXACTLY, which would confine every
    // namespace to the one base path. Namespaces are routed by URL
    // (`/ws/chat` -> '/chat'), so the adapter owns the upgrade step itself
    // and accepts the base path and anything below it. handleUpgrade()
    // still applies verifyClient and maxPayload exactly as server mode did.
    const base = (options.path || '/ws').replace(/\/+$/, '') || '/';
    this.basePath = base.startsWith('/') ? base : `/${base}`;

    const originConfigured = options.cors?.origin !== undefined && options.cors?.origin !== null;
    if (!originConfigured) {
      this.wsLogger.info(
        'WebSocket origin check: websocket.options.cors.origin is not set, so a browser may ' +
          'connect only from the same origin (the Origin host must equal the Host header); ' +
          'clients that send no Origin header are accepted. ' +
          'Set websocket.options.cors.origin to allow other origins.'
      );
    }

    const verify = this.buildVerifyClient(options);

    // websocket.compression (the framework passes it as options.compression):
    // permessage-deflate with every client that offers it. Without it the key
    // is left out and `ws` declines the extension, its default.
    this.compressionOn = options.compression === true || this.compressionRequested;

    this.wss = new WebSocketServer({
      noServer: true,
      ...(this.compressionOn ? { perMessageDeflate: wsPerMessageDeflate() } : {}),
      // 1 MiB unless configured: every frame is buffered whole (and, on an
      // event namespace, JSON-parsed) before a handler sees it.
      maxPayload: options.maxPayloadLength || DEFAULT_MAX_PAYLOAD,
      // Origin allowlist + optional custom upgrade-auth hook. Without this a
      // cookie-authenticated app is open to cross-site WebSocket hijacking:
      // the browser sends auth cookies on a ws:// upgrade from any page.
      // Handed to ws in its callback form so a verifyClient hook that
      // returns a promise is decided by what the promise resolves to.
      verifyClient: verify
        ? (
            info: { origin?: string; req: any; secure: boolean },
            done: (ok: boolean, code?: number) => void
          ) => {
            const verdict: unknown = verify(info);
            if (verdict !== null && typeof verdict === 'object' && 'then' in verdict) {
              (verdict as Promise<unknown>).then(
                ok => done(!!ok, 401),
                () => done(false, 401)
              );
            } else {
              done(!!verdict, 401);
            }
          }
        : undefined,
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
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
        }
        return;
      }
      if (this.compressionOn) declineUnacceptableOffers(req);
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
  }

  /**
   * Build a `ws` verifyClient callback enforcing the CORS origin rule and any
   * user-supplied upgrade-auth hook (`options.verifyClient`).
   *
   * `cors.origin` accepts:
   *   - not set                 -> same-origin only (as `false`)
   *   - true / '*'              -> allow any origin
   *   - false                   -> same-origin only
   *   - string                  -> that exact origin
   *   - string[]                -> any origin in the list
   *   - RegExp                  -> a matching origin
   *   - (requestOrigin) => ...  -> dynamic: return true (allow), false (deny),
   *                                '*' (allow), or the allowed origin string
   *                                (allowed when it equals the request origin).
   *
   * Same-origin: a request without an Origin header (a non-browser client)
   * passes; one with an Origin passes when its host equals the Host header.
   */
  private buildVerifyClient(
    options: WebSocketAdapterOptions
  ): ((info: { origin?: string; req: any; secure: boolean }) => boolean) | undefined {
    // An application that configured nothing gets the same-origin rule.
    const corsOrigin = options.cors?.origin ?? false;
    const userVerify =
      typeof (options as any).verifyClient === 'function'
        ? ((options as any).verifyClient as (info: any) => boolean)
        : undefined;

    // Allow-all cases need no enforcement at all.
    const allowAll = corsOrigin === true || corsOrigin === '*';
    if (allowAll && !userVerify) {
      return undefined;
    }

    return (info: { origin?: string; req: any; secure: boolean }): boolean => {
      try {
        // allowAll (true/'*') is handled above; here corsOrigin is a specific
        // rule to enforce.
        if (!allowAll) {
          const origin = info.origin;
          let ok: boolean;
          if (typeof corsOrigin === 'function') {
            // Dynamic: allow based on the function's decision for this origin.
            const decision = (corsOrigin as (o: string | undefined) => boolean | string)(origin);
            ok = decision === true || decision === '*' || (!!origin && decision === origin);
          } else {
            ok = originMatchesRule(corsOrigin, origin, info.req);
          }
          if (!ok) {
            this.wsLogger.warn(
              `Rejected WebSocket upgrade from disallowed origin: ${origin ?? '(none)'}`
            );
            return false;
          }
        }
        return userVerify ? userVerify(info) : true;
      } catch (error) {
        // A hook that throws must refuse the handshake, not take the process
        // down from inside the server's 'upgrade' event.
        this.wsLogger.warn(
          `Rejected WebSocket upgrade: the origin/verifyClient check threw: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return false;
      }
    };
  }

  private handleConnection(ws: any, request: any): void {
    const id = this.generateId();
    const connection = new WSConnectionWrapper(id, ws, request, this.resolveClientAddress);

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
    if (!enabled) return;
    // Before initialize(): the server is created with it.
    if (!this.wss) {
      this.compressionRequested = true;
      return;
    }
    // In force: `ws` negotiates the extension, compresses and inflates.
    if (this.compressionOn) return;
    // The server exists and was created without permessage-deflate: frames
    // go on being sent as they are. Said once.
    if (this.compressionWarned) return;
    this.compressionWarned = true;
    this.wsLogger.warn(
      'websocket.compression is set but is not applied by the ws adapter: ' +
        'permessage-deflate is not negotiated and messages are sent uncompressed. ' +
        'It is turned on when the adapter starts: set websocket.compression in the ' +
        'app configuration.'
    );
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
  }

  setClientAddressResolver(resolve: ClientAddressResolver): void {
    this.resolveClientAddress = resolve;
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
    // Unguessable: an application may use the id as a private room name.
    return randomUUID();
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
    // What socket.broadcast and socket.to(room) on this connection reach: the
    // sockets that have joined this namespace.
    connection.peers = this.connections;
    // The connection joins the namespace (and so starts receiving its
    // broadcasts) only once every middleware has passed.
    this.runMiddlewares(connection, err => {
      if (err) {
        namespaceLogger.debug(
          `WebSocket connection ${connection.id} refused by namespace middleware (${this.namespacePath}): ${err.message}`
        );
        connection.refuse();
        return;
      }
      // The client may have gone away while an asynchronous middleware ran
      if (!connection.connected) return;

      this.connections.set(connection.id, connection);
      // Clean up on disconnect
      connection.on('close', () => {
        this.connections.delete(connection.id);
      });

      // Notify connection handlers - optimized with for loop
      const handlers = this.connectionHandlers;
      const len = handlers.length;
      for (let i = 0; i < len; i++) {
        handlers[i]?.(connection);
      }
    });
  }

  /**
   * Run the namespace middleware in order. `done` is called exactly once:
   * with the error of the first middleware that called `next(err)` (or threw,
   * or returned a promise that rejected), or with nothing when all passed.
   */
  private runMiddlewares(connection: WSConnectionWrapper, done: (err?: Error) => void): void {
    let index = 0;
    let finished = false;

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      done(err);
    };
    const toError = (reason: unknown) =>
      reason instanceof Error ? reason : new Error(String(reason));

    const next = (err?: Error) => {
      if (finished) return;
      if (err) {
        finish(toError(err));
        return;
      }
      const middleware = this.middlewares[index++];
      if (!middleware) {
        finish();
        return;
      }
      try {
        const result: unknown = middleware(connection, next);
        if (result !== null && typeof result === 'object' && 'then' in result) {
          (result as Promise<unknown>).then(undefined, reason => finish(toError(reason)));
        }
      } catch (error) {
        finish(toError(error));
      }
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
  /** Handlers for events a client sends */
  private eventHandlers = new Map<string, CallableFunction[]>();
  /** Handlers for the adapter's own events (LIFECYCLE_EVENTS); never fed from the wire */
  private lifecycleHandlers = new Map<string, CallableFunction[]>();
  private anyHandlers: CallableFunction[] = [];
  private rooms = new Set<string>();
  private _connected = true;
  /**
   * The joined sockets of the namespace this connection was routed to (set by
   * the namespace; a connection joins it once its middleware has passed).
   */
  public peers: Map<string, WSConnectionWrapper> = new Map();
  /** The address the connection came from, read at the handshake */
  private peerAddress: string | undefined;
  /** With server.trustProxy set: the client's address, decided at the handshake */
  private clientAddress: string | undefined;

  constructor(
    public readonly id: string,
    public readonly ws: any,
    private request: any,
    resolveClientAddress?: ClientAddressResolver
  ) {
    // Read now: a socket has no address any more once it has closed
    this.peerAddress = request.socket?.remoteAddress || undefined;
    if (resolveClientAddress !== undefined) {
      const forwardedFor: unknown = request.headers?.['x-forwarded-for'];
      this.clientAddress = resolveClientAddress(
        this.peerAddress || '',
        typeof forwardedFor === 'string' ? forwardedFor : undefined
      );
    }

    // Setup message handling
    this.ws.on('message', (data: Buffer, isBinary?: boolean) => {
      this.handleMessage(data, isBinary === true);
    });

    this.ws.on('close', (code?: number, reason?: Buffer) => {
      this._connected = false;
      this.raise('close');
      // The documented `disconnect` hook (app.websocket({ disconnect })) - a
      // client-facing frame makes no sense on a closed socket, so it is
      // dispatched locally with the close code, like the engine adapter.
      const handlers = this.lifecycleHandlers.get('disconnect');
      if (handlers) {
        const detail = { code, reason: reason ? reason.toString() : '' };
        for (let i = 0; i < handlers.length; i++) handlers[i]?.(detail);
      }
    });

    this.ws.on('error', (error: Error) => {
      this.raise('error', error);
    });
  }

  get ip(): string | undefined {
    // server.trustProxy: the client as the trusted proxies report it, as
    // req.ip is. Without it the connected peer: X-Forwarded-For is whatever
    // the client sent, and counts only through that setting.
    return this.clientAddress !== undefined ? this.clientAddress : this.peerAddress;
  }

  get headers(): Record<string, string> | undefined {
    return this.request.headers;
  }

  get connected(): boolean {
    return this._connected && this.ws.readyState === 1; // WebSocket.OPEN
  }

  // Emit to everyone in this socket's namespace except this socket
  get broadcast(): WebSocketEmitter {
    return new WSEmitterWrapper(this.peers, undefined, undefined, this.id);
  }

  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void {
    const registry = LIFECYCLE_EVENTS.has(event) ? this.lifecycleHandlers : this.eventHandlers;
    const handlers = registry.get(event);
    if (handlers) handlers.push(handler);
    else registry.set(event, [handler]);
  }

  onAny(handler: (event: string, ...args: any[]) => void): void {
    this.anyHandlers.push(handler);
  }

  emit(event: string, data?: any): void {
    // Every name is an event for the client, as on the engine and Socket.IO
    // adapters. That includes 'error' (what the framework answers when a
    // handler failed on a message that asked for no reply) and 'close'. The
    // adapter's own events of those names - the socket failed, the socket
    // closed - reach the server-side handlers through raise(), never from here.
    if (this.connected) {
      const message = JSON.stringify({ event, data });
      this.ws.send(message);
    }
  }

  /** Run the server-side handlers of one of the adapter's own events. */
  private raise(event: string, data?: unknown): void {
    const handlers = this.lifecycleHandlers.get(event);
    if (handlers) {
      const len = handlers.length;
      for (let i = 0; i < len; i++) {
        handlers[i]?.(data);
      }
    }
  }

  compressedEmit(event: string, data: any): void {
    // Same frame as emit(): with websocket.compression a frame of 1024 bytes
    // or more is compressed on a connection that negotiated
    // permessage-deflate, and without it nothing is.
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

  // Emit to the members of the room(s) in this socket's namespace (this
  // socket too when it is one of them, as on the engine adapter)
  to(room: string | string[]): WebSocketEmitter {
    return new WSEmitterWrapper(this.peers, room);
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

  /** Close a connection that namespace middleware refused (1008, policy violation). */
  refuse(): void {
    this._connected = false;
    try {
      if (this.ws.readyState === 1) this.ws.close(1008, 'Connection refused');
    } catch {
      // socket already going away
    }
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

      // The adapter's own events are not client-sendable
      if (LIFECYCLE_EVENTS.has(event)) return;

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
    // Not a per-emit choice on this adapter (see compressedEmit); chaining preserved
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
