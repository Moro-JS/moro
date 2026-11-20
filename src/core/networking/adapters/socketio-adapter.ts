// Socket.IO WebSocket Adapter for Moro Framework
// Implements the WebSocket adapter interface using Socket.IO

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
  askOriginFunction,
  isSameOriginRequest,
  originMatchesRule,
  reportOnlyNotice,
  restrictsOrigin,
} from '../websocket-adapter.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { declineUnacceptableOffers, wsPerMessageDeflate } from './ws-deflate.js';

/** Engine.IO's `allowRequest`: decides a handshake before any transport opens. */
type AllowRequest = (
  req: any,
  callback: (err: string | null | undefined, success: boolean) => void
) => void;

/**
 * Socket.IO adapter implementation
 */
export class SocketIOAdapter implements WebSocketAdapter {
  private io: any; // Socket.IO server instance
  private customIdGenerator?: () => string;
  private ioLogger = createFrameworkLogger('SOCKETIO_ADAPTER');
  /** Set when server.trustProxy is: who the client of a handshake is */
  resolveClientAddress: ClientAddressResolver | undefined;
  /** setCompression(true) before initialize(): taken up there */
  private compressionRequested = false;
  /** The server was created with permessage-deflate on its WebSocket transport */
  private compressionOn = false;
  private compressionWarned = false;

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    try {
      // Dynamic import from user's context to find their installed socket.io
      const socketIOPath = resolveUserPackage('socket.io');
      const { Server } = await import(socketIOPath);

      // No `cors` at all (the adapter used on its own; the framework always
      // passes an object): Socket.IO then sends no CORS headers, which keeps
      // a page on another origin off long-polling, and nothing more. Its
      // WebSocket transport accepts every origin, so say so.
      const corsConfig = options.cors;
      if (!corsConfig) {
        this.ioLogger.warn(
          'websocket.options.cors.origin is not set: no origin is refused (Socket.IO sends no ' +
            'CORS headers for long-polling, and its WebSocket transport accepts every origin). ' +
            'Set websocket.options.cors.origin to restrict the origins that may connect.'
        );
      }

      // Socket.IO's `cors` option only answers CORS for long-polling; nothing
      // in it stops a page on another origin from opening the WebSocket
      // transport. A configured origin rule and `verifyClient` are therefore
      // enforced in `allowRequest`, which every transport's handshake goes
      // through.
      const allowRequest = this.buildAllowRequest(options);
      if (allowRequest && options.enforceHandshakeChecks === false) {
        this.ioLogger.warn(
          reportOnlyNotice(
            restrictsOrigin(options.cors?.origin),
            typeof options.verifyClient === 'function'
          )
        );
      }

      // websocket.compression (the framework passes it as options.compression)
      // is this adapter's own switch and not a Socket.IO option: it turns on
      // Socket.IO's `perMessageDeflate`, which is off by default, for the
      // WebSocket transport. A `perMessageDeflate` among the options is the
      // application's own setting and takes its place, whatever it says.
      // (Long-polling responses are a separate Socket.IO option,
      // `httpCompression`, on by default and left as it is.)
      const { compression, ...socketIOOptions } = options;
      const shorthand = compression === true || this.compressionRequested;
      const own: unknown = socketIOOptions.perMessageDeflate;
      this.compressionOn = own !== undefined ? !!own : shorthand;
      const shorthandInForce = shorthand && own === undefined;

      this.io = new Server(httpServer, {
        ...(corsConfig ? { cors: corsConfig } : {}),
        path: options.path || '/socket.io/',
        // The largest accepted message, and with compression the largest a
        // message may inflate to. Left out when the application set no
        // limit, so that Socket.IO's own default (1 MB) applies: the key with
        // no value would switch the limit off on both transports.
        ...(typeof options.maxPayloadLength === 'number'
          ? { maxHttpBufferSize: options.maxPayloadLength }
          : {}),
        ...(shorthandInForce ? { perMessageDeflate: wsPerMessageDeflate() } : {}),
        ...socketIOOptions,
        ...(allowRequest ? { allowRequest } : {}),
      });
      // An offer `ws` would refuse the handshake over is declined instead,
      // ahead of the upgrade (see ws-deflate.ts).
      if (shorthandInForce && typeof this.io.engine?.use === 'function') {
        this.io.engine.use((req: any, _res: unknown, next: () => void) => {
          declineUnacceptableOffers(req);
          next();
        });
      }

      // Apply custom ID generator if set
      if (this.customIdGenerator) {
        (this.io.engine as any).generateId = this.customIdGenerator;
      }
    } catch {
      throw new Error(
        'Socket.IO not found. Install it with: npm install socket.io\n' +
          'Or use a different WebSocket adapter.'
      );
    }
  }

  // One WARN line per handshake that failed a check for the first twenty,
  // then one in every 500, so a flood of them cannot flood the log. It says
  // whether the handshake was refused or (enforceHandshakeChecks: false) let
  // through.
  private failedHandshakes = 0;
  private reportFailed(reason: string, origin: string | undefined, refused: boolean): void {
    const n = ++this.failedHandshakes;
    if (n > 20 && n % 500 !== 0) return;
    const what = `(${reason}${origin !== undefined ? `; origin ${origin.slice(0, 200)}` : ''})`;
    this.ioLogger.warn(
      (refused
        ? `Refused Socket.IO handshake ${what}`
        : `Socket.IO handshake failed a check but was ALLOWED ${what}: ` +
          'websocket.options.enforceHandshakeChecks is false') + `${n > 20 ? ` (${n} so far)` : ''}`
    );
  }

  /**
   * Build Engine.IO's `allowRequest` from `cors.origin` and `verifyClient`,
   * or return undefined when the application configured neither (Socket.IO
   * then behaves exactly as it does without this adapter's involvement).
   *
   * Origin rule (only when `cors.origin` is set):
   *   - no Origin header (a non-browser client)       -> accepted
   *   - Origin host equals the Host header            -> accepted (a browser
   *     never applies CORS to a same-origin request, so these always worked)
   *   - otherwise the origin must satisfy `cors.origin`: true / '*', an exact
   *     string, a RegExp, a list of those, or a function. A function is
   *     called the way Socket.IO's CORS handling calls it,
   *     `(origin, callback(err, allow))`; one that returns its decision
   *     instead (the `ws` adapter form) is honoured too.
   *
   * `verifyClient({ origin, req, secure })` then runs for every handshake;
   * a falsy result (or a throw) fails it. A failed check refuses the
   * handshake; with `enforceHandshakeChecks: false` it is logged instead and
   * the handshake proceeds (see WebSocketAdapterOptions.enforceHandshakeChecks).
   * An `allowRequest` the application passed in its options still runs
   * afterwards.
   */
  private buildAllowRequest(options: WebSocketAdapterOptions): AllowRequest | undefined {
    const corsOrigin = options.cors?.origin;
    // Nothing to enforce for an unset origin or an allow-all one
    const originConfigured = restrictsOrigin(corsOrigin);
    const userVerify =
      typeof options.verifyClient === 'function' ? options.verifyClient : undefined;
    if (!originConfigured && !userVerify) return undefined;

    const enforce = options.enforceHandshakeChecks !== false;

    const userAllowRequest: AllowRequest | undefined =
      typeof options.allowRequest === 'function' ? options.allowRequest : undefined;

    return (req, callback) => {
      const header = req?.headers?.origin;
      const origin: string | undefined = typeof header === 'string' && header ? header : undefined;

      const accept = () => {
        if (userAllowRequest) userAllowRequest(req, callback);
        else callback(null, true);
      };
      // Refused, unless the application turned the refusal off: the warning
      // then says what would have been refused and the handshake goes on.
      const reject = (message: string) => {
        this.reportFailed(message, origin, enforce);
        if (enforce) return callback(message, false);
        accept();
      };

      const verify = () => {
        if (!userVerify) return accept();
        let verdict: unknown;
        try {
          verdict = userVerify({
            ...(origin !== undefined ? { origin } : {}),
            req,
            secure: !!(req?.socket?.authorized || req?.socket?.encrypted),
          });
        } catch (error) {
          return reject(
            `verifyClient threw: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (verdict !== null && typeof verdict === 'object' && 'then' in verdict) {
          (verdict as Promise<unknown>).then(
            ok => (ok ? accept() : reject('verifyClient refused the handshake')),
            () => reject('verifyClient refused the handshake')
          );
          return;
        }
        if (verdict) accept();
        else reject('verifyClient refused the handshake');
      };

      if (!originConfigured || origin === undefined || isSameOriginRequest(origin, req)) {
        return verify();
      }

      const decide = (allowed: boolean) => {
        if (allowed) return verify();
        reject('Origin not allowed');
      };

      if (typeof corsOrigin !== 'function') {
        return decide(originMatchesRule(corsOrigin, origin, req));
      }

      // Dynamic rule. Settles once, from the callback or from a returned value.
      askOriginFunction(corsOrigin, origin, req, decide);
    };
  }

  createNamespace(namespace: string, options?: WebSocketNamespaceOptions): WebSocketNamespace {
    if (!this.io) {
      throw new Error('Socket.IO adapter not initialized');
    }
    if (options?.raw) {
      // Socket.IO clients speak the Socket.IO protocol, so there is no raw
      // frame to expose; the namespace behaves as an event namespace.
      createFrameworkLogger('SocketIOAdapter').warn(
        `WebSocket namespace ${namespace}: { raw: true } is not supported by the Socket.IO adapter (use the engine or ws adapter for raw frames)`,
        'Namespace'
      );
    }

    const ns = this.io.of(namespace);
    return new SocketIONamespaceWrapper(ns, this);
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

  setCompression(enabled: boolean, _options: any = {}): void {
    if (!enabled) return;
    // Before initialize(): the server is created with it.
    if (!this.io) {
      this.compressionRequested = true;
      return;
    }
    // In force: Socket.IO's WebSocket transport negotiates the extension.
    if (this.compressionOn) return;
    // The server exists, and Socket.IO reads `perMessageDeflate` only when
    // it is created: frames go on being sent as they are. Said once.
    if (this.compressionWarned) return;
    this.compressionWarned = true;
    this.ioLogger.warn(
      'websocket.compression is set but is not applied by the Socket.IO adapter: ' +
        'permessage-deflate is not negotiated and WebSocket messages are sent uncompressed. ' +
        'It is turned on when the adapter starts: set websocket.compression in the ' +
        'app configuration.'
    );
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
    if (this.io) {
      (this.io.engine as any).generateId = generator;
    }
  }

  setClientAddressResolver(resolve: ClientAddressResolver): void {
    this.resolveClientAddress = resolve;
  }

  getAdapterName(): string {
    return 'socket.io';
  }

  getConnectionCount(): number {
    if (!this.io) return 0;
    return this.io.engine.clientsCount || 0;
  }
}

/** Where a connection asks who its client is: the adapter it belongs to. */
interface AddressSource {
  resolveClientAddress: ClientAddressResolver | undefined;
}

/**
 * Socket.IO namespace wrapper
 */
class SocketIONamespaceWrapper implements WebSocketNamespace {
  constructor(
    private namespace: any,
    private addresses?: AddressSource
  ) {}

  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void {
    this.namespace.on(event, (socket: any) => {
      handler(new SocketIOConnectionWrapper(socket, this.addresses));
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
    return Array.from(sockets.values()).map(
      (socket: any) => new SocketIOConnectionWrapper(socket, this.addresses)
    );
  }

  getConnectionCount(): number {
    return this.namespace.sockets.size;
  }

  use(middleware: WebSocketMiddleware): void {
    this.namespace.use((socket: any, next: any) => {
      middleware(new SocketIOConnectionWrapper(socket, this.addresses), next);
    });
  }
}

/**
 * Socket.IO connection wrapper
 */
class SocketIOConnectionWrapper implements WebSocketConnection {
  public data: Record<string, any> = {};

  constructor(
    private socket: any,
    private addresses?: AddressSource
  ) {
    // Map socket.data to our data property
    this.data = socket.data || {};
  }

  get id(): string {
    return this.socket.id;
  }

  get ip(): string | undefined {
    const handshake = this.socket.handshake;
    const peer: string | undefined = handshake?.address;
    // server.trustProxy: the client as the trusted proxies report it, as req.ip is
    const resolve = this.addresses?.resolveClientAddress;
    if (resolve === undefined) return peer;
    const forwardedFor: unknown = handshake?.headers?.['x-forwarded-for'];
    return resolve(peer || '', typeof forwardedFor === 'string' ? forwardedFor : undefined);
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

  /** Socket.IO's own send(): delivers a 'message' event to the client */
  send(data: string | Buffer | ArrayBuffer | Uint8Array, _isBinary?: boolean): void {
    this.socket.send(data);
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
