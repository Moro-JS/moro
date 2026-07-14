// @morojs/engine WebSocket adapter.
// Bridges the native engine's RFC 6455 WebSocket callbacks (onWsOpen/Message/
// Close, wsSend/wsClose on MoroEngineServer) to Moro's WebSocketAdapter model.
// Message framing mirrors the uWS adapter: JSON { event, data } envelopes with
// a default namespace, so app.websocket() handlers work identically.

import crypto from 'crypto';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
} from '../websocket-adapter.js';
import { createFrameworkLogger } from '../../logger/index.js';

// Parse a raw upgrade query string (`orgId=1&x=y`, with or without a leading
// `?`) into a flat object for `socket.handshake.query`. Last value wins on
// duplicate keys, matching URLSearchParams / Socket.IO.
function parseQueryString(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  const params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
  for (const [key, value] of params) out[key] = value;
  return out;
}

export class EngineWebSocketAdapter implements WebSocketAdapter {
  private server: any; // MoroEngineServer
  private namespaces = new Map<string, EngineNamespaceWrapper>();
  private connections = new Map<string, EngineConnectionWrapper>();
  private byWsId = new Map<number, EngineConnectionWrapper>();
  private logger = createFrameworkLogger('ENGINE_WS');
  private customIdGenerator?: () => string;
  private connectionCounter = 0;

  async initialize(httpServer: any, _options: WebSocketAdapterOptions = {}): Promise<void> {
    if (!httpServer || typeof httpServer.enableWebSocket !== 'function') {
      throw new Error(
        'EngineWebSocketAdapter requires the @morojs/engine HTTP server (MoroEngineServer)'
      );
    }
    this.server = httpServer;

    // Register the native WS bridge: the engine drives these on the event loop.
    this.server.enableWebSocket({
      onOpen: (
        wsId: number,
        path: string,
        info?: { ip: string; headers: Record<string, string>; query?: string }
      ) => this.handleOpen(wsId, path, info),
      onMessage: (wsId: number, data: any, isBinary: boolean) =>
        this.handleMessage(wsId, data, isBinary),
      onClose: (wsId: number, code: number) => this.handleClose(wsId, code),
    });

    this.createNamespace('/');
    this.logger.info('Engine WebSocket adapter initialized', 'Init');
  }

  private handleOpen(
    wsId: number,
    path: string,
    info?: { ip: string; headers: Record<string, string>; query?: string }
  ): void {
    const id = this.customIdGenerator ? this.customIdGenerator() : this.generateId();
    const connection = new EngineConnectionWrapper(
      this.server,
      wsId,
      id,
      path,
      this.namespaces,
      info
    );
    this.connections.set(id, connection);
    this.byWsId.set(wsId, connection);
    // Route to the namespace whose registered path matches the upgrade URL
    // (Socket.IO parity for `app.websocket('/name', ...)`), falling back to the
    // default namespace when nothing matches. Query/hash are stripped so a
    // client connecting to `/name?token=…` still resolves to the `/name`
    // namespace.
    const nsPath = (path || '/').split(/[?#]/)[0] || '/';
    const ns =
      (this.namespaces.get(nsPath) as EngineNamespaceWrapper | undefined) ??
      this.getDefaultNamespaceImpl();
    ns.handleConnection(connection);
  }

  private handleMessage(wsId: number, data: any, isBinary: boolean): void {
    const connection = this.byWsId.get(wsId);
    if (!connection) return;
    if (isBinary) {
      connection.handleBinary(data);
      return;
    }
    // Text frames carry JSON { event, data } envelopes (uWS-adapter parity)
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.warn(`Non-JSON message from ${connection.id}`, 'Message');
      return;
    }
    connection.handleMessage(parsed);
  }

  private handleClose(wsId: number, code: number): void {
    const connection = this.byWsId.get(wsId);
    if (!connection) return;
    connection.connected = false;
    connection.handleDisconnect(code);
    this.byWsId.delete(wsId);
    this.connections.delete(connection.id);
  }

  private generateId(): string {
    return `${Date.now().toString(36)}-${(++this.connectionCounter).toString(36)}-${crypto
      .randomBytes(4)
      .toString('hex')}`;
  }

  private getDefaultNamespaceImpl(): EngineNamespaceWrapper {
    return this.createNamespace('/') as EngineNamespaceWrapper;
  }

  createNamespace(namespace: string): WebSocketNamespace {
    let ns = this.namespaces.get(namespace);
    if (!ns) {
      ns = new EngineNamespaceWrapper(namespace, this.connections);
      this.namespaces.set(namespace, ns);
    }
    return ns;
  }

  getDefaultNamespace(): WebSocketNamespace {
    return this.createNamespace('/');
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.disconnect();
    }
    this.connections.clear();
    this.byWsId.clear();
  }

  setCompression(_enabled: boolean, _options?: any): void {
    // Compression (permessage-deflate) is negotiated natively; no-op for now.
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
  }

  getAdapterName(): string {
    return '@morojs/engine';
  }

  getConnectionCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.connected) count++;
    }
    return count;
  }
}

class EngineNamespaceWrapper implements WebSocketNamespace {
  private connectionHandlers: ((socket: WebSocketConnection) => void)[] = [];
  private middlewares: WebSocketMiddleware[] = [];
  private logger = createFrameworkLogger('ENGINE_WS_NS');

  constructor(
    private namespace: string,
    private connections: Map<string, EngineConnectionWrapper>
  ) {}

  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void {
    if (event === 'connection') this.connectionHandlers.push(handler);
  }

  handleConnection(connection: EngineConnectionWrapper): void {
    this.runMiddlewares(connection, err => {
      if (err) {
        connection.disconnect(true);
        return;
      }
      // A throwing connection handler must not take down the socket/loop.
      for (const handler of this.connectionHandlers) {
        try {
          handler(connection);
        } catch (error) {
          this.logger.error(
            `WebSocket connection handler threw: ${error instanceof Error ? error.message : String(error)}`,
            'Connection'
          );
        }
      }
    });
  }

  private runMiddlewares(
    connection: EngineConnectionWrapper,
    finalCallback: (err?: Error) => void
  ): void {
    let index = 0;
    const next = (err?: Error) => {
      if (err) return finalCallback(err);
      if (index >= this.middlewares.length) return finalCallback();
      const middleware = this.middlewares[index++];
      middleware?.(connection, next);
    };
    next();
  }

  emit(event: string, data: any): void {
    for (const connection of this.connections.values()) {
      if (connection.connected) connection.emit(event, data);
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new EngineEmitterWrapper(this.connections, {
      rooms: Array.isArray(room) ? room : [room],
    });
  }

  except(room: string | string[]): WebSocketEmitter {
    return new EngineEmitterWrapper(this.connections, {
      exceptRooms: Array.isArray(room) ? room : [room],
    });
  }

  getSockets(): WebSocketConnection[] {
    const result: WebSocketConnection[] = [];
    for (const conn of this.connections.values()) if (conn.connected) result.push(conn);
    return result;
  }

  getConnectionCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) if (conn.connected) count++;
    return count;
  }

  use(middleware: WebSocketMiddleware): void {
    this.middlewares.push(middleware);
  }
}

class EngineConnectionWrapper implements WebSocketConnection {
  public data: Record<string, any> = {};
  public connected = true;
  public readonly headers: Record<string, string>;
  public readonly query: Record<string, string>;
  private rooms = new Set<string>();
  private eventHandlers = new Map<
    string,
    Array<(data: any, callback?: (response?: any) => void) => void>
  >();
  private anyHandlers: Array<(event: string, ...args: any[]) => void> = [];
  private disconnectHandlers: Array<(reason?: any) => void> = [];
  private logger = createFrameworkLogger('ENGINE_WS_CONN');
  private readonly _ip: string;

  constructor(
    private server: any,
    private wsId: number,
    public readonly id: string,
    public readonly path: string,
    private namespaces: Map<string, EngineNamespaceWrapper>,
    handshake?: { ip: string; headers: Record<string, string>; query?: string }
  ) {
    // Handshake snapshot (captured before the upgrade invalidated the reqId):
    // real values for IP-based rate limiting and header/token connection auth.
    this._ip = handshake?.ip ?? '';
    this.headers = handshake?.headers ?? {};
    this.query = parseQueryString(handshake?.query ?? '');
  }

  get ip(): string {
    return this._ip;
  }

  // Socket.IO-parity handshake view so `socket.handshake.query`/`.headers`
  // handlers (e.g. reading an `orgId` query param) work against the engine
  // adapter unchanged.
  get handshake(): {
    query: Record<string, string>;
    headers: Record<string, string>;
    address: string;
  } {
    return { query: this.query, headers: this.headers, address: this._ip };
  }

  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void {
    if (event === 'disconnect') {
      this.disconnectHandlers.push(handler as any);
      return;
    }
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = [];
      this.eventHandlers.set(event, handlers);
    }
    handlers.push(handler);
  }

  onAny(handler: (event: string, ...args: any[]) => void): void {
    this.anyHandlers.push(handler);
  }

  emit(event: string, data: any): void {
    if (!this.connected) return;
    try {
      const sent = this.server.wsSend(this.wsId, JSON.stringify({ event, data }), false);
      if (!sent) this.logger.warn(`Backpressure for connection ${this.id}`, 'Backpressure');
    } catch (error) {
      this.logger.error(
        `Failed to emit ${event}: ${error instanceof Error ? error.message : String(error)}`,
        'Emit'
      );
    }
  }

  compressedEmit(event: string, data: any): void {
    this.emit(event, data);
  }

  // A user handler throwing must not kill the connection, skip sibling
  // handlers, or (via the native callback) get swallowed silently.
  private runHandler(fn: (...args: any[]) => void, ...args: any[]): void {
    try {
      fn(...args);
    } catch (error) {
      this.logger.error(
        `WebSocket handler threw: ${error instanceof Error ? error.message : String(error)}`,
        'Handler'
      );
    }
  }

  handleMessage(data: any): void {
    // A frame delivered after the socket was closed (e.g. a second frame in the
    // same TCP read whose first frame's handler called disconnect()) must not
    // reach app handlers on a dead socket.
    if (!this.connected) return;
    if (!data || typeof data !== 'object') return;
    const { event, data: eventData, callback: hasCallback } = data;
    if (!event) return;

    const callback = hasCallback
      ? (response?: any) => this.emit(`${event}:response`, response)
      : undefined;

    for (const handler of this.anyHandlers) this.runHandler(handler, event, eventData);
    const handlers = this.eventHandlers.get(event);
    if (handlers) for (const handler of handlers) this.runHandler(handler, eventData, callback);
  }

  handleBinary(data: any): void {
    if (!this.connected) return;
    const handlers = this.eventHandlers.get('binary');
    if (handlers) for (const handler of handlers) this.runHandler(handler, data);
  }

  handleDisconnect(reason?: any): void {
    for (const handler of this.disconnectHandlers) this.runHandler(handler, reason);
  }

  join(room: string | string[]): void {
    for (const r of Array.isArray(room) ? room : [room]) this.rooms.add(r);
  }

  leave(room: string | string[]): void {
    for (const r of Array.isArray(room) ? room : [room]) this.rooms.delete(r);
  }

  getRooms(): Set<string> {
    return new Set(this.rooms);
  }

  isInRoom(room: string): boolean {
    return this.rooms.has(room);
  }

  disconnect(_close?: boolean): void {
    if (!this.connected) return;
    this.connected = false;
    try {
      this.server.wsClose(this.wsId, 1000, '');
    } catch {
      // already gone
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new EngineEmitterWrapper(this.allConnections(), {
      rooms: Array.isArray(room) ? room : [room],
    });
  }

  // Emit to everyone in the default namespace except this socket
  get broadcast(): WebSocketEmitter {
    return new EngineEmitterWrapper(this.allConnections(), { exceptId: this.id });
  }

  private allConnections(): Map<string, EngineConnectionWrapper> {
    return (this.namespaces.get('/') as any)?.['connections'] ?? new Map();
  }
}

class EngineEmitterWrapper implements WebSocketEmitter {
  constructor(
    private connections: Map<string, EngineConnectionWrapper>,
    private filter: { rooms?: string[]; exceptRooms?: string[]; exceptId?: string }
  ) {}

  emit(event: string, data: any): void {
    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      if (this.filter.exceptId && conn.id === this.filter.exceptId) continue;
      if (this.filter.rooms && !this.filter.rooms.some(r => conn.isInRoom(r))) continue;
      if (this.filter.exceptRooms && this.filter.exceptRooms.some(r => conn.isInRoom(r))) continue;
      conn.emit(event, data);
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    const rooms = Array.isArray(room) ? room : [room];
    return new EngineEmitterWrapper(this.connections, {
      ...this.filter,
      rooms: [...(this.filter.rooms ?? []), ...rooms],
    });
  }

  except(room: string | string[]): WebSocketEmitter {
    const rooms = Array.isArray(room) ? room : [room];
    return new EngineEmitterWrapper(this.connections, {
      ...this.filter,
      exceptRooms: [...(this.filter.exceptRooms ?? []), ...rooms],
    });
  }

  compress(_compress: boolean): WebSocketEmitter {
    return this; // native negotiation; chaining preserved
  }
}
