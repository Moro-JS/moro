// @morojs/engine WebSocket adapter.
// Bridges the native engine's RFC 6455 WebSocket callbacks (onWsOpen/Message/
// Close, wsSend/wsClose on MoroEngineServer) to Moro's WebSocketAdapter model.
// Message framing: JSON { event, data } envelopes with a default namespace, as
// on the other adapters, so app.websocket() handlers work identically.

import crypto from 'crypto';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketNamespaceOptions,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
  askOriginFunction,
  isSameOriginRequest,
  originMatchesRule,
  reportOnlyNotice,
  restrictsOrigin,
} from '../websocket-adapter.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { clientAddress, type ProxyTrust } from '../../http/utils/trust-proxy.js';

// One logger per role for the whole process, not one per namespace or per
// connection: a child logger was being built on every upgrade.
const nsLogger = createFrameworkLogger('ENGINE_WS_NS');
const connLogger = createFrameworkLogger('ENGINE_WS_CONN');

// Random bytes for connection ids, drawn from a pool refilled in one call:
// crypto.randomBytes(4) per upgrade was a CSPRNG call and a Buffer each.
const ID_POOL = Buffer.allocUnsafe(4096);
let idPoolOffset = ID_POOL.length;
function randomIdSuffix(): string {
  if (idPoolOffset + 4 > ID_POOL.length) {
    crypto.randomFillSync(ID_POOL);
    idPoolOffset = 0;
  }
  const hex = ID_POOL.toString('hex', idPoolOffset, idPoolOffset + 4);
  idPoolOffset += 4;
  return hex;
}

// The handshake headers as the EngineRequest.headers getter builds them:
// keys already lowercased, duplicate lines joined ('; ' for cookie, ', '
// otherwise) - last-wins would let a client send two X-Forwarded-For lines
// and hide the earlier one from IP-based WS auth / rate-limiting.
function headersFromFlat(flat: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!flat) return headers;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = flat[i];
    const val = flat[i + 1];
    if (key === undefined || val === undefined) continue;
    const existing = headers[key];
    headers[key] = existing === undefined ? val : existing + (key === 'cookie' ? '; ' : ', ') + val;
  }
  return headers;
}

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

// An upgrade request as MoroEngineServer hands it to the bridge's
// verifyUpgrade, before the engine has answered it.
interface UpgradeRequest {
  ip: string;
  flat: string[] | undefined;
  query: string;
  path: string;
  method: string;
  secure: boolean;
}

// What verifyUpgrade answers: nothing to let the upgrade go ahead, or the HTTP
// status the handshake is refused with.
type UpgradeVerdict = number | undefined;

// Refused before the 101: an origin the rule does not allow, and a
// verifyClient that said no (the status the ws adapter answers with).
const ORIGIN_REFUSED = 403;
const VERIFY_REFUSED = 401;

export class EngineWebSocketAdapter implements WebSocketAdapter {
  private server: any; // MoroEngineServer
  // Each namespace keeps the sockets that joined it (see
  // EngineNamespaceWrapper.sockets); nothing is shared between namespaces.
  private namespaces = new Map<string, EngineNamespaceWrapper>();
  // Every open socket, from the engine's open callback to its close callback,
  // including one whose namespace middleware has not given its verdict yet.
  private byWsId = new Map<number, EngineConnectionWrapper>();
  private logger = createFrameworkLogger('ENGINE_WS');
  private customIdGenerator?: () => string;
  private connectionCounter = 0;
  private compressionWarned = false;
  private refusedHandshakes = 0;

  async initialize(httpServer: any, options: WebSocketAdapterOptions = {}): Promise<void> {
    if (!httpServer || typeof httpServer.enableWebSocket !== 'function') {
      throw new Error(
        'EngineWebSocketAdapter requires the @morojs/engine HTTP server (MoroEngineServer)'
      );
    }
    this.server = httpServer;
    // A configured origin rule and verifyClient are evaluated before the
    // upgrade is answered, and a handshake that fails is refused.
    // enforceHandshakeChecks: false keeps the evaluation and drops the
    // refusal: the failure is logged and the handshake is upgraded. With
    // neither configured there is no check to run, verifyUpgrade is undefined
    // and the engine goes on answering handshakes by itself.
    const enforce = options.enforceHandshakeChecks !== false;
    this.warnUnappliedOptions(options);
    const verifyUpgrade = this.buildVerifyUpgrade(options, enforce);
    if (verifyUpgrade && !enforce) {
      this.logger.warn(
        reportOnlyNotice(
          restrictsOrigin(options.cors?.origin),
          typeof options.verifyClient === 'function'
        ),
        'Options'
      );
    }

    // Register the native WS bridge: the engine drives these on the event loop.
    // With verifyUpgrade on the bridge the server keeps the upgrade in its
    // request callback, where the handshake can still be refused.
    this.server.enableWebSocket({
      onOpen: (
        wsId: number,
        path: string,
        info?: { ip: string; flat?: string[] | undefined; query?: string }
      ) => this.handleOpen(wsId, path, info),
      onMessage: (wsId: number, data: any, isBinary: boolean) =>
        this.handleMessage(wsId, data, isBinary),
      onClose: (wsId: number, code: number) => this.handleClose(wsId, code),
      ...(verifyUpgrade ? { verifyUpgrade } : {}),
    });

    this.createNamespace('/');
    this.logger.info('Engine WebSocket adapter initialized', 'Init');
  }

  // `websocket.options` keys that the ws and Socket.IO adapters act on and
  // this adapter does not. Each one that is set gets one WARN line at
  // start-up, so a configured limit or path is not taken to be in force.
  private warnUnappliedOptions(options: WebSocketAdapterOptions): void {
    const warn = (message: string) => this.logger.warn(message, 'Options');
    if (options.maxPayloadLength !== undefined) {
      // The engine's cap is server.limits.wsMaxMessageSize. A value that
      // reached it (the two were set alike) is in force and needs no line.
      const inForce: unknown = this.server._limits?.wsMaxMessageSize;
      if (inForce !== options.maxPayloadLength) {
        warn(
          `websocket.options.maxPayloadLength (${options.maxPayloadLength}) is set but is not ` +
            'applied by the native engine WebSocket adapter: the largest accepted message is ' +
            (typeof inForce === 'number' ? `${inForce} bytes` : 'the engine default, 16 MiB') +
            ' (server.limits.wsMaxMessageSize).'
        );
      }
    }
    if (options.idleTimeout !== undefined) {
      warn(
        'websocket.options.idleTimeout is set but is not applied by the native engine ' +
          'WebSocket adapter: a silent connection is not closed.'
      );
    }
    if (options.path !== undefined) {
      warn(
        'websocket.options.path is set but is not applied by the native engine WebSocket ' +
          "adapter: a namespace is served at its own path (app.websocket('/chat') at /chat)."
      );
    }
  }

  // The handshake checks, as the function the server calls for an upgrade
  // request before answering it; undefined when there is nothing to check (no
  // origin rule that could refuse, no verifyClient), and the engine may then
  // go on upgrading by itself. With `enforce` off a failed check is reported
  // and the handshake goes ahead.
  //
  // The rules are the Socket.IO adapter's:
  //   - origin: checked only when cors.origin is set to something other than
  //     true / '*'. A request without an Origin header (not a browser page)
  //     and a same-origin request (Origin host equals the Host header) pass;
  //     any other origin must satisfy the rule - an exact string, a RegExp, a
  //     list of those, false (same-origin only) or a function, called as
  //     (origin, callback(err, allow)) and also honoured when it returns its
  //     decision (or a promise of it) instead.
  //   - verifyClient({ origin, req, secure }) then runs for every handshake
  //     that passed; a falsy result, a throw or a rejection refuses it.
  private buildVerifyUpgrade(
    options: WebSocketAdapterOptions,
    enforce: boolean
  ): ((request: UpgradeRequest) => UpgradeVerdict | Promise<UpgradeVerdict>) | undefined {
    const corsOrigin = options.cors?.origin;
    const originConfigured = restrictsOrigin(corsOrigin);
    const userVerify =
      typeof options.verifyClient === 'function' ? options.verifyClient : undefined;
    if (!originConfigured && !userVerify) return undefined;

    const refuse = (status: number, reason: string, origin: string | undefined): UpgradeVerdict => {
      this.reportFailed(reason, origin, enforce);
      return enforce ? status : undefined;
    };

    return (request: UpgradeRequest) => {
      const headers = headersFromFlat(request.flat);
      const header = headers.origin;
      const origin: string | undefined = typeof header === 'string' && header ? header : undefined;
      // What a verifyClient written for the other adapters reads off the
      // Node request: the headers, the URL, the peer address.
      const socket = { remoteAddress: request.ip, encrypted: request.secure };
      // server.trustProxy: req.ip is the client, as it is for an HTTP request
      const trust: ProxyTrust | undefined = this.server.proxyTrust;
      const req = {
        method: request.method,
        url: request.query ? `${request.path}?${request.query}` : request.path,
        headers,
        socket,
        connection: socket,
        ip:
          trust === undefined
            ? request.ip
            : clientAddress(request.ip, headers['x-forwarded-for'], trust),
      };

      const verify = (): UpgradeVerdict | Promise<UpgradeVerdict> => {
        if (!userVerify) return undefined;
        let verdict: unknown;
        try {
          verdict = userVerify({
            ...(origin !== undefined ? { origin } : {}),
            req,
            secure: request.secure,
          });
        } catch (error) {
          return refuse(
            VERIFY_REFUSED,
            `verifyClient threw: ${error instanceof Error ? error.message : String(error)}`,
            origin
          );
        }
        if (
          verdict !== null &&
          typeof verdict === 'object' &&
          typeof (verdict as PromiseLike<unknown>).then === 'function'
        ) {
          return Promise.resolve(verdict as PromiseLike<unknown>).then(
            ok =>
              ok ? undefined : refuse(VERIFY_REFUSED, 'verifyClient refused the handshake', origin),
            error =>
              refuse(
                VERIFY_REFUSED,
                `verifyClient rejected: ${error instanceof Error ? error.message : String(error)}`,
                origin
              )
          );
        }
        return verdict
          ? undefined
          : refuse(VERIFY_REFUSED, 'verifyClient refused the handshake', origin);
      };

      if (!originConfigured || origin === undefined || isSameOriginRequest(origin, req)) {
        return verify();
      }
      const decide = (allowed: boolean) =>
        allowed ? verify() : refuse(ORIGIN_REFUSED, 'Origin not allowed', origin);
      if (typeof corsOrigin !== 'function') {
        return decide(originMatchesRule(corsOrigin, origin, req));
      }

      // Dynamic rule: settled once, by its callback or by what it returns.
      return new Promise<UpgradeVerdict>(resolve => {
        askOriginFunction(corsOrigin, origin, req, allowed => resolve(decide(allowed)));
      });
    };
  }

  // One WARN line per handshake that failed a check for the first twenty,
  // then one in every 500, so a flood of them cannot flood the log. It says
  // whether the handshake was refused or (enforceHandshakeChecks: false) let
  // through.
  private reportFailed(reason: string, origin: string | undefined, refused: boolean): void {
    const n = ++this.refusedHandshakes;
    if (n > 20 && n % 500 !== 0) return;
    const what = `(${reason}${origin !== undefined ? `; origin ${origin.slice(0, 200)}` : ''})`;
    this.logger.warn(
      (refused
        ? `Refused WebSocket handshake ${what}`
        : `WebSocket handshake failed a check but was ALLOWED ${what}: ` +
          'websocket.options.enforceHandshakeChecks is false') +
        `${n > 20 ? ` (${n} so far)` : ''}`,
      'Handshake'
    );
  }

  private handleOpen(
    wsId: number,
    path: string,
    info?: { ip: string; flat?: string[] | undefined; query?: string }
  ): void {
    const id = this.customIdGenerator ? this.customIdGenerator() : this.generateId();
    // Route to the namespace whose registered path matches the upgrade URL
    // (Socket.IO parity for `app.websocket('/name', ...)`). A path with no
    // namespace of its own is served by the default namespace, as on the ws
    // adapter. Query/hash are stripped so a client connecting to
    // `/name?token=…` still resolves to the `/name` namespace.
    const nsPath = (path || '/').split(/[?#]/)[0] || '/';
    const ns =
      (this.namespaces.get(nsPath) as EngineNamespaceWrapper | undefined) ??
      this.getDefaultNamespaceImpl();
    const connection = new EngineConnectionWrapper(this.server, wsId, id, path, ns.sockets, info);
    // Known to the engine callbacks from here on. The socket joins its
    // namespace (and so starts receiving that namespace's broadcasts) in
    // handleConnection, once every middleware has passed.
    this.byWsId.set(wsId, connection);
    connection.raw = ns.raw;
    ns.handleConnection(connection);
  }

  private handleMessage(wsId: number, data: any, isBinary: boolean): void {
    const connection = this.byWsId.get(wsId);
    if (!connection) return;
    if (connection.raw) {
      // Raw namespace: no envelope, no parse - the frame is the message
      if (isBinary) connection.handleBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      else
        connection.handleRawText(
          typeof data === 'string' ? data : Buffer.from(data).toString('utf-8')
        );
      return;
    }
    if (isBinary) {
      connection.handleBinary(data);
      return;
    }
    // Text frames carry JSON { event, data } envelopes
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      // One WARN line for the connection's first such frame; the rest are
      // counted and reported when the connection closes.
      if (connection.nonJsonFrames++ === 0) {
        this.logger.warn(
          `Non-JSON message from ${connection.id} (ignored; further ones on this connection are counted and reported when it closes)`,
          'Message'
        );
      }
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
    connection.leaveNamespace();
    this.reportCounted(connection);
  }

  // The totals behind the one WARN line each of these got at its first
  // occurrence on the connection.
  private reportCounted(connection: EngineConnectionWrapper): void {
    if (connection.nonJsonFrames > 1) {
      this.logger.warn(
        `Non-JSON messages from ${connection.id}: ${connection.nonJsonFrames} in total, all ignored`,
        'Message'
      );
    }
    if (connection.backpressureSends > 1) {
      connLogger.warn(
        `Backpressure for connection ${connection.id}: ${connection.backpressureSends} sends in total`,
        'Backpressure'
      );
    }
  }

  private generateId(): string {
    return `${Date.now().toString(36)}-${(++this.connectionCounter).toString(36)}-${randomIdSuffix()}`;
  }

  private getDefaultNamespaceImpl(): EngineNamespaceWrapper {
    return this.createNamespace('/') as EngineNamespaceWrapper;
  }

  createNamespace(namespace: string, options?: WebSocketNamespaceOptions): WebSocketNamespace {
    let ns = this.namespaces.get(namespace);
    if (!ns) {
      ns = new EngineNamespaceWrapper(namespace);
      this.namespaces.set(namespace, ns);
    }
    if (options?.raw) ns.raw = true;
    return ns;
  }

  getDefaultNamespace(): WebSocketNamespace {
    return this.createNamespace('/');
  }

  async close(): Promise<void> {
    // byWsId, not the namespaces' sockets: one still waiting on its namespace
    // middleware is open too.
    for (const conn of this.byWsId.values()) {
      conn.disconnect();
      conn.leaveNamespace();
      this.reportCounted(conn);
    }
    this.byWsId.clear();
  }

  setCompression(enabled: boolean, _options?: any): void {
    if (!enabled) return;
    // In force: the server was created with websocket.compression and the
    // engine has permessage-deflate (capabilities.wsDeflate). The engine
    // negotiates it with each client that offers it, compresses what it sends
    // such a client and inflates what it receives; nothing is done here.
    if (this.server?.wsCompression === true) return;
    // Not applied: the engine's permessage-deflate is not turned on for the
    // server this adapter is given, so frames go out as they are. Said once.
    if (this.compressionWarned) return;
    this.compressionWarned = true;
    this.logger.warn(
      'websocket.compression is set but is not applied by the native engine WebSocket ' +
        'adapter: permessage-deflate is not negotiated and messages are sent uncompressed.' +
        // The engine has it, and the server was created without the setting
        (this.server?._capabilities?.wsDeflate === true
          ? ' It is turned on when the server is created: set websocket.compression in the ' +
            'app configuration.'
          : ''),
      'Options'
    );
  }

  setCustomIdGenerator(generator: () => string): void {
    this.customIdGenerator = generator;
  }

  getAdapterName(): string {
    return '@morojs/engine';
  }

  // The adapter's count is the one call that spans namespaces: every socket
  // that has joined any of them.
  getConnectionCount(): number {
    let count = 0;
    for (const ns of this.namespaces.values()) count += ns.getConnectionCount();
    return count;
  }
}

class EngineNamespaceWrapper implements WebSocketNamespace {
  /** Raw framing for connections routed here (see WebSocketNamespaceOptions) */
  raw = false;
  /**
   * The sockets that have joined this namespace (passed its middleware): what
   * emit(), to(), except() and getSockets() here, and socket.broadcast and
   * socket.to() on one of them, reach. Rooms are a filter over this set, so a
   * room name belongs to the namespace too.
   */
  readonly sockets = new Map<string, EngineConnectionWrapper>();
  private connectionHandlers: ((socket: WebSocketConnection) => void)[] = [];
  private middlewares: WebSocketMiddleware[] = [];
  private middlewareFailureLogged = false;
  private logger = nsLogger;

  constructor(private namespace: string) {}

  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void {
    if (event === 'connection') this.connectionHandlers.push(handler);
  }

  handleConnection(connection: EngineConnectionWrapper): void {
    if (this.middlewares.length === 0) {
      this.join(connection);
      return;
    }
    this.runMiddlewares(connection, (err, failed) => {
      if (err) {
        // A middleware that threw (or whose promise rejected) is a fault in
        // the application, not a refusal it chose: the first one on this
        // namespace is logged as an error, later ones at debug like any
        // other refusal.
        const line = `WebSocket connection ${connection.id} refused by namespace middleware (${this.namespace}): ${err.message}`;
        if (failed && !this.middlewareFailureLogged) {
          this.middlewareFailureLogged = true;
          this.logger.error(
            `${line} (the middleware threw or rejected; further failures on this namespace are logged at debug)`,
            'Middleware'
          );
        } else {
          this.logger.debug(line, 'Middleware');
        }
        connection.disconnect(true);
        return;
      }
      this.join(connection);
    });
  }

  // The socket becomes a member: broadcasts reach it, getSockets() lists it,
  // the connection handlers run. Only after every middleware has passed.
  private join(connection: EngineConnectionWrapper): void {
    // The client went away, or a middleware closed the socket, while an
    // asynchronous middleware was running: there is nothing to join.
    if (!connection.connected) return;
    this.sockets.set(connection.id, connection);
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
  }

  // Run the namespace middleware in order. `done` is called exactly once:
  // with the error of the first middleware that called `next(err)`, threw, or
  // returned a promise that rejected (`failed` is true for the last two), or
  // with nothing when every middleware called `next()`. A second `next()`
  // from the same middleware, and anything after the verdict, is ignored.
  private runMiddlewares(
    connection: EngineConnectionWrapper,
    done: (err?: Error, failed?: boolean) => void
  ): void {
    let finished = false;
    const finish = (err?: Error, failed?: boolean) => {
      if (finished) return;
      finished = true;
      done(err, failed);
    };
    const toError = (reason: unknown) =>
      reason instanceof Error ? reason : new Error(String(reason));
    // A throw or a rejection. Before the verdict it refuses the socket; after
    // it (the socket has joined, or was already refused) it is only recorded.
    const fail = (reason: unknown) => {
      const error = toError(reason);
      if (finished) {
        this.logger.debug(
          `Namespace middleware (${this.namespace}) failed after its verdict for ${connection.id}: ${error.message}`,
          'Middleware'
        );
        return;
      }
      finish(error, true);
    };

    const run = (index: number) => {
      const middleware = this.middlewares[index];
      if (!middleware) {
        finish();
        return;
      }
      let called = false;
      const next = (err?: Error) => {
        if (called || finished) return;
        called = true;
        if (err) finish(toError(err));
        else run(index + 1);
      };
      try {
        const result: unknown = middleware(connection, next);
        if (
          result !== null &&
          typeof result === 'object' &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        ) {
          (result as PromiseLike<unknown>).then(undefined, fail);
        }
      } catch (error) {
        fail(error);
      }
    };
    run(0);
  }

  emit(event: string, data: any): void {
    for (const connection of this.sockets.values()) {
      if (connection.connected) connection.emit(event, data);
    }
  }

  to(room: string | string[]): WebSocketEmitter {
    return new EngineEmitterWrapper(this.sockets, {
      rooms: Array.isArray(room) ? room : [room],
    });
  }

  except(room: string | string[]): WebSocketEmitter {
    return new EngineEmitterWrapper(this.sockets, {
      exceptRooms: Array.isArray(room) ? room : [room],
    });
  }

  getSockets(): WebSocketConnection[] {
    const result: WebSocketConnection[] = [];
    for (const conn of this.sockets.values()) if (conn.connected) result.push(conn);
    return result;
  }

  getConnectionCount(): number {
    let count = 0;
    for (const conn of this.sockets.values()) if (conn.connected) count++;
    return count;
  }

  use(middleware: WebSocketMiddleware): void {
    this.middlewares.push(middleware);
  }
}

class EngineConnectionWrapper implements WebSocketConnection {
  public data: Record<string, any> = {};
  public connected = true;
  /** Raw framing (set from the namespace at open) */
  public raw = false;
  /** Text frames that were not JSON envelopes (logged once, then counted) */
  public nonJsonFrames = 0;
  /** Sends the engine reported backpressure for (logged once, then counted) */
  public backpressureSends = 0;
  private _flat: string[] | undefined;
  private _headers: Record<string, string> | undefined = undefined;
  private _query: Record<string, string> | undefined = undefined;
  private _queryString: string;
  // The engine upgraded this socket itself (wsAutoUpgrade): the handshake is
  // fetched from the engine the first time ip, headers or query is read. It
  // stays readable through the disconnect handler; a read after that gets
  // the empty values.
  private _lazy: boolean;
  private rooms = new Set<string>();
  private eventHandlers = new Map<
    string,
    Array<(data: any, callback?: (response?: any) => void) => void>
  >();
  private anyHandlers: Array<(event: string, ...args: any[]) => void> = [];
  // The 'message' and 'binary' handler lists, kept at hand: a raw text or a
  // binary frame reaches them without a map lookup per frame.
  private messageHandlers: Array<(data: any, callback?: (response?: any) => void) => void> = [];
  private binaryHandlers: Array<(data: any, callback?: (response?: any) => void) => void> = [];
  private disconnectHandlers: Array<(reason?: any) => void> = [];
  private logger = connLogger;
  private _ip: string;

  constructor(
    private server: any,
    private wsId: number,
    public readonly id: string,
    public readonly path: string,
    // The joined sockets of the namespace this connection was routed to
    private peers: Map<string, EngineConnectionWrapper>,
    handshake?: { ip: string; flat?: string[] | undefined; query?: string }
  ) {
    // Handshake snapshot (captured before the upgrade invalidated the reqId):
    // real values for IP-based rate limiting and header/token connection
    // auth. The header object and the parsed query are built on first read.
    // Without a snapshot the engine performed the upgrade and holds the
    // handshake: it is fetched on first read (see _lazy).
    this._lazy = handshake === undefined;
    this._ip = handshake?.ip ?? '';
    this._flat = handshake?.flat;
    this._queryString = handshake?.query ?? '';
  }

  private materialize(): void {
    this._lazy = false;
    const hs =
      typeof this.server.wsHandshake === 'function'
        ? this.server.wsHandshake(this.wsId)
        : undefined;
    if (hs) {
      this._ip = hs.ip;
      this._flat = hs.flat;
      this._queryString = hs.query;
    }
  }

  get ip(): string {
    if (this._lazy) this.materialize();
    // server.trustProxy: the client as the trusted proxies report it, as
    // req.ip is. Without the setting, the peer the connection comes from.
    const trust: ProxyTrust | undefined = this.server.proxyTrust;
    if (trust === undefined) return this._ip;
    return clientAddress(this._ip, this.headers['x-forwarded-for'], trust);
  }

  /** The handshake request's headers, keys lowercased, duplicates joined. */
  get headers(): Record<string, string> {
    let h = this._headers;
    if (h === undefined) {
      if (this._lazy) this.materialize();
      h = headersFromFlat(this._flat);
      this._flat = undefined;
      this._headers = h;
    }
    return h;
  }

  /** The handshake request's query parameters. */
  get query(): Record<string, string> {
    let q = this._query;
    if (q === undefined) {
      if (this._lazy) this.materialize();
      q = parseQueryString(this._queryString);
      this._query = q;
    }
    return q;
  }

  // Socket.IO-parity handshake view so `socket.handshake.query`/`.headers`
  // handlers (e.g. reading an `orgId` query param) work against the engine
  // adapter unchanged.
  get handshake(): {
    query: Record<string, string>;
    headers: Record<string, string>;
    address: string;
  } {
    return { query: this.query, headers: this.headers, address: this.ip };
  }

  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void {
    if (event === 'disconnect') {
      this.disconnectHandlers.push(handler as any);
      return;
    }
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers =
        event === 'message' ? this.messageHandlers : event === 'binary' ? this.binaryHandlers : [];
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
      if (!sent) this.noteBackpressure();
    } catch (error) {
      this.logger.error(
        `Failed to emit ${event}: ${error instanceof Error ? error.message : String(error)}`,
        'Emit'
      );
    }
  }

  // Same frame as emit(): with websocket.compression the engine compresses
  // every frame of 1024 bytes or more on a connection that negotiated
  // permessage-deflate, and without it nothing is compressed.
  compressedEmit(event: string, data: any): void {
    this.emit(event, data);
  }

  // One WARN line for the connection's first send under backpressure; the
  // rest are counted and reported when the connection closes.
  private noteBackpressure(): void {
    if (this.backpressureSends++ === 0) {
      this.logger.warn(
        `Backpressure for connection ${this.id} (further sends under backpressure on this connection are counted and reported when it closes)`,
        'Backpressure'
      );
    }
  }

  send(data: string | Buffer | ArrayBuffer | Uint8Array, isBinary?: boolean): void {
    if (!this.connected) return;
    try {
      const binary = isBinary ?? typeof data !== 'string';
      const sent = this.server.wsSend(this.wsId, data, binary);
      if (!sent) this.noteBackpressure();
    } catch (error) {
      this.logger.error(
        `Failed to send frame: ${error instanceof Error ? error.message : String(error)}`,
        'Send'
      );
    }
  }

  /** Raw namespace: a text frame reaches the 'message' handlers verbatim */
  handleRawText(text: string): void {
    if (!this.connected) return;
    for (const handler of this.anyHandlers) this.runHandler(handler, 'message', text);
    for (const handler of this.messageHandlers) this.runHandler(handler, text);
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
    for (const handler of this.binaryHandlers) this.runHandler(handler, data);
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

  // Emit to the members of the room(s) in this socket's namespace
  to(room: string | string[]): WebSocketEmitter {
    return new EngineEmitterWrapper(this.peers, {
      rooms: Array.isArray(room) ? room : [room],
    });
  }

  // Emit to everyone in this socket's namespace except this socket
  get broadcast(): WebSocketEmitter {
    return new EngineEmitterWrapper(this.peers, { exceptId: this.id });
  }

  // The socket closed: it is no longer a member of its namespace. A socket
  // that never joined (refused, or closed while its middleware was still
  // running) has no entry of its own to remove.
  leaveNamespace(): void {
    if (this.peers.get(this.id) === this) this.peers.delete(this.id);
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
    // Not a per-emit choice on this adapter (see compressedEmit); chaining preserved
    return this;
  }
}
