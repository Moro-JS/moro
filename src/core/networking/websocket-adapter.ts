// WebSocket Adapter Interface for Moro Framework
// Provides a common interface for different WebSocket implementations

export interface WebSocketAdapterOptions {
  /**
   * `true`: permessage-deflate with every client that offers it; a message of
   * 1024 bytes or more sent to such a client is compressed, and the adapter's
   * message size limit also bounds a message once inflated. The framework
   * sets it from `websocket.compression`; set it yourself only for an adapter
   * you initialize on your own. Read when the adapter starts.
   */
  compression?: boolean;
  cors?: {
    /**
     * Allowed origin(s) for cross-origin WebSocket upgrades.
     * - `true` / `'*'` — allow any origin
     * - `false` — same-origin only
     * - `string` / `string[]` — exact origin(s)
     * - `RegExp` — matched origin
     * - function — dynamic: the `ws` adapter calls it `(requestOrigin) => boolean | string`
     *   (return `true`/`'*'` to allow, `false` to deny, or the allowed origin string);
     *   the Socket.IO adapter passes it through to Socket.IO (express-cors `(origin, callback)`).
     *
     * Not set:
     * - `ws` adapter — same-origin only: a request that carries an `Origin`
     *   header is accepted when that origin's host equals the request's `Host`
     *   header; a request without `Origin` (a non-browser client) is accepted.
     * - Socket.IO adapter — origins are not checked.
     * - native engine adapter — origins are not checked.
     *
     * Set to anything other than `true` / `'*'`, every adapter refuses a
     * handshake from an origin the value does not allow. A request without an
     * `Origin` header, and a same-origin request, are always accepted.
     *
     * - Socket.IO adapter — applied to the handshake of every transport
     *   (long-polling, answered `403`, and WebSocket, answered `400`).
     * - native engine adapter — another origin is answered `403` and the
     *   connection is not upgraded. A function is called `(origin, callback)`
     *   and may return its decision instead.
     *
     * On those two adapters `enforceHandshakeChecks: false` turns the refusal
     * into a logged warning.
     */
    origin?:
      | string
      | string[]
      | boolean
      | RegExp
      | ((
          requestOrigin: string | undefined,
          callback?: (err: Error | null, allow?: boolean) => void
        ) => boolean | string | void);
    methods?: string[];
    credentials?: boolean;
  };
  path?: string;
  /**
   * Largest accepted message, in bytes. The `ws` adapter defaults to 1 MiB
   * (1048576) when this is not set and closes a connection that sends more.
   * The Socket.IO adapter passes it to Socket.IO as `maxHttpBufferSize`; when
   * it is not set Socket.IO's own default applies (1 MB, 1000000 bytes), and
   * a larger message closes the connection (a long-polling request is
   * answered `413`). On the native engine adapter the limit is
   * `server.limits.wsMaxMessageSize` (16 MiB when not set).
   */
  maxPayloadLength?: number;
  idleTimeout?: number;
  /**
   * Optional upgrade-time authentication hook, applied by every adapter.
   * Return false, or a promise that resolves to false, to reject the
   * handshake; a hook that throws, or whose promise rejects, rejects it too.
   * Runs after the CORS origin check passes. A refused handshake is answered
   * `401` by the `ws` and native engine adapters; Socket.IO answers `403` on
   * long-polling and `400` on the WebSocket transport. On the native engine
   * adapter `req` carries the handshake's `method`, `url`, `headers`,
   * `socket.remoteAddress` and `ip` (the client, once `server.trustProxy` is
   * set).
   */
  verifyClient?: (info: {
    origin?: string;
    req: any;
    secure: boolean;
  }) => boolean | Promise<boolean>;
  /**
   * Socket.IO and native engine adapters: whether a handshake that fails the
   * `cors.origin` rule or `verifyClient` is refused. Both adapters evaluate
   * whichever of the two is configured before the connection is established
   * (Socket.IO: on every transport's handshake; native engine: before the
   * upgrade is answered).
   *
   * - not set, or `true` — a handshake that fails is refused.
   * - `false` — a handshake that fails is logged as a warning and let
   *   through, and one line at start-up says so. Meant for the time it takes
   *   to correct an origin list or a `verifyClient` that refuses clients it
   *   should not.
   *
   * With neither `cors.origin` (other than `true` / `'*'`) nor `verifyClient`
   * configured there is nothing to check and the option has no effect. The
   * `ws` adapter always refuses and does not read this option.
   */
  enforceHandshakeChecks?: boolean;
  [key: string]: any; // Allow adapter-specific options
}

/** Per-namespace options for createNamespace() / app.websocket(). */
export interface WebSocketNamespaceOptions {
  /**
   * Raw framing: frames on this namespace are NOT `{ event, data }` JSON
   * envelopes. Every text frame reaches the `message` handler as a string and
   * every binary frame reaches `binary` as a Buffer; replies go out through
   * `socket.send()`. Supported by the engine and ws adapters (Socket.IO
   * speaks its own protocol and ignores it).
   */
  raw?: boolean;
}

/**
 * Abstract WebSocket adapter interface
 * Allows the framework to work with different WebSocket implementations
 */
export interface WebSocketAdapter {
  /**
   * Initialize the WebSocket server with the given HTTP server
   */
  initialize(httpServer: any, options?: WebSocketAdapterOptions): Promise<void>;

  /**
   * Create a namespace for organizing WebSocket connections
   */
  createNamespace(namespace: string, options?: WebSocketNamespaceOptions): WebSocketNamespace;

  /**
   * Get the default namespace (usually '/')
   */
  getDefaultNamespace(): WebSocketNamespace;

  /**
   * Close the WebSocket server and all connections
   */
  close(): Promise<void>;

  /**
   * Set compression configuration
   */
  setCompression(enabled: boolean, options?: any): void;

  /**
   * Set custom ID generator for connections
   */
  setCustomIdGenerator(generator: () => string): void;

  /**
   * Get adapter name/type
   */
  getAdapterName(): string;

  /**
   * Get connection count across all namespaces
   */
  getConnectionCount(): number;

  /**
   * Optional. Called once, before the server listens, when `server.trustProxy`
   * is set: `resolve` turns the address a handshake arrived from and its
   * `X-Forwarded-For` header into the client's address, the way `req.ip` is
   * derived for an HTTP request. An adapter that implements it reports that
   * address as `socket.ip`. Never called when the setting is absent, and an
   * adapter without the method reports the connected peer.
   */
  setClientAddressResolver?(resolve: ClientAddressResolver): void;
}

/**
 * WebSocket namespace interface
 * Represents a logical grouping of WebSocket connections
 */
export interface WebSocketNamespace {
  /**
   * Listen for connection events
   */
  on(event: 'connection', handler: (socket: WebSocketConnection) => void): void;

  /**
   * Emit event to all connected sockets in this namespace
   */
  emit(event: string, data: any): void;

  /**
   * Emit to specific room(s)
   */
  to(room: string | string[]): WebSocketEmitter;

  /**
   * Emit to sockets except those in specified room(s)
   */
  except(room: string | string[]): WebSocketEmitter;

  /**
   * Get all connected sockets
   */
  getSockets(): WebSocketConnection[];

  /**
   * Get connection count for this namespace
   */
  getConnectionCount(): number;

  /**
   * Use middleware for this namespace
   */
  use(middleware: (socket: WebSocketConnection, next: (err?: Error) => void) => void): void;
}

/**
 * The client's address for a handshake: `peer` is the address the connection
 * comes from, `forwardedFor` the handshake's `X-Forwarded-For` header.
 */
export type ClientAddressResolver = (peer: string, forwardedFor: string | undefined) => string;

/**
 * WebSocket connection interface
 * Represents an individual client connection
 */
export interface WebSocketConnection {
  /** Unique connection ID */
  id: string;

  /**
   * Client IP address: the peer the connection comes from or, with
   * `server.trustProxy` set, the client the trusted proxies name in the
   * handshake's `X-Forwarded-For` (what `req.ip` is for an HTTP request)
   */
  ip?: string | undefined;

  /** Connection headers */
  headers?: Record<string, string> | undefined;

  /** Custom data storage */
  data: Record<string, any>;

  /**
   * Listen for events from this socket
   */
  on(event: string, handler: (data: any, callback?: (response?: any) => void) => void): void;

  /**
   * Listen for any event from this socket
   */
  onAny(handler: (event: string, ...args: any[]) => void): void;

  /**
   * Emit event to this socket
   */
  emit(event: string, data: any): void;

  /**
   * Emit with compression
   */
  compressedEmit?(event: string, data: any): void;

  /**
   * Send one frame as-is, with no `{ event, data }` envelope: a string goes
   * out as a text frame, a Buffer/ArrayBuffer/Uint8Array as a binary frame
   * (`isBinary` overrides the guess). The reply side of a raw namespace; every
   * built-in adapter implements it.
   */
  send?(data: string | Buffer | ArrayBuffer | Uint8Array, isBinary?: boolean): void;

  /**
   * Join a room
   */
  join(room: string | string[]): void;

  /**
   * Leave a room
   */
  leave(room: string | string[]): void;

  /**
   * Emit to specific room(s)
   */
  to(room: string | string[]): WebSocketEmitter;

  /**
   * Emit to all sockets except this one
   */
  broadcast: WebSocketEmitter;

  /**
   * Get rooms this socket has joined
   */
  getRooms(): Set<string>;

  /**
   * Disconnect this socket
   */
  disconnect(close?: boolean): void;

  /**
   * Check if socket is connected
   */
  connected: boolean;
}

/**
 * WebSocket emitter interface for chaining operations
 */
export interface WebSocketEmitter {
  /**
   * Emit to target sockets
   */
  emit(event: string, data: any): void;

  /**
   * Target specific room(s)
   */
  to(room: string | string[]): WebSocketEmitter;

  /**
   * Exclude specific room(s)
   */
  except(room: string | string[]): WebSocketEmitter;

  /**
   * Use compression for this emit
   */
  compress(compress: boolean): WebSocketEmitter;
}

/**
 * WebSocket middleware function type
 */
export type WebSocketMiddleware = (
  socket: WebSocketConnection,
  next: (err?: Error) => void
) => void;

/**
 * WebSocket event handler type
 */
export type WebSocketEventHandler = (
  socket: WebSocketConnection,
  data: any,
  callback?: (response?: any) => void
) => void | Promise<void>;

/**
 * Same-origin test for a WebSocket handshake: the `Origin` header's host
 * (host and port) equals the request's `Host` header.
 * @internal
 */
export function isSameOriginRequest(origin: string, req: any): boolean {
  try {
    const host = req?.headers?.host;
    return typeof host === 'string' && host !== '' && new URL(origin).host === host.toLowerCase();
  } catch {
    // an Origin that is not a URL ("null", garbage) is never same-origin
    return false;
  }
}

/**
 * Whether a request origin satisfies a static `cors.origin` rule (every form
 * except the function one, which each adapter calls in its own way):
 *   true / '*'  any origin
 *   false       same-origin only; a request without Origin passes
 *   string      that exact origin
 *   RegExp      a matching origin
 *   array       any listed origin (strings exact, RegExp entries tested)
 * Anything else matches nothing.
 * @internal
 */
export function originMatchesRule(rule: unknown, origin: string | undefined, req: any): boolean {
  if (rule === true || rule === '*') return true;
  if (rule === false) return !origin || isSameOriginRequest(origin, req);
  if (!origin) return false;
  if (typeof rule === 'string') return origin === rule;
  if (rule instanceof RegExp) return rule.test(origin);
  if (Array.isArray(rule)) {
    for (let i = 0; i < rule.length; i++) {
      const entry = rule[i];
      if (entry === origin || (entry instanceof RegExp && entry.test(origin))) return true;
    }
  }
  return false;
}

/**
 * Whether a `cors.origin` value can refuse an origin: anything set, other
 * than the allow-all forms `true` and `'*'`.
 * @internal
 */
export function restrictsOrigin(rule: unknown): boolean {
  return rule !== undefined && rule !== null && rule !== true && rule !== '*';
}

/**
 * The start-up line of an adapter running with `enforceHandshakeChecks: false`
 * while an origin rule or `verifyClient` is configured.
 * @internal
 */
export function reportOnlyNotice(originConfigured: boolean, verifyConfigured: boolean): string {
  const checks = [
    ...(originConfigured ? ['websocket.options.cors.origin'] : []),
    ...(verifyConfigured ? ['websocket.options.verifyClient'] : []),
  ].join(' and ');
  return (
    `websocket.options.enforceHandshakeChecks is false: a handshake that fails ${checks} is ` +
    'logged and allowed, not refused. Remove the option to have it refused.'
  );
}

/**
 * Ask a function-form `cors.origin` about a request origin, as the Socket.IO
 * and native engine adapters do. The function is called the way Socket.IO's
 * CORS handling calls it, `(origin, callback(err, allow))`, where `allow` is
 * itself an origin rule; one that returns its decision instead (`true` / `'*'`
 * / the origin to allow, `false` to deny), or a promise of it, is honoured
 * too. A throw or a rejection denies. `done` is called once, with the first
 * answer.
 * @internal
 */
export function askOriginFunction(
  rule: (
    requestOrigin: string | undefined,
    callback?: (err: Error | null, allow?: boolean) => void
  ) => boolean | string | void,
  origin: string,
  req: any,
  done: (allowed: boolean) => void
): void {
  let settled = false;
  const settle = (allowed: boolean) => {
    if (settled) return;
    settled = true;
    done(allowed);
  };
  const fromReturn = (value: unknown) => {
    if (value === true || value === '*' || value === origin) settle(true);
    else if (value === false) settle(false);
  };
  try {
    const returned: unknown = rule(origin, (err, allow?: unknown) => {
      settle(!err && originMatchesRule(allow ?? false, origin, req));
    });
    if (returned !== null && typeof returned === 'object' && 'then' in returned) {
      (returned as Promise<unknown>).then(fromReturn, () => settle(false));
    } else {
      fromReturn(returned);
    }
  } catch {
    settle(false);
  }
}

/**
 * Merge WebSocket config from moro.config.ts with per-call createApp() options.
 * createApp() options take precedence over config for top-level and nested keys,
 * so `options.path` overrides `config.options.path` and same for cors fields.
 * @internal
 */
export function mergeWebSocketConfig(cfg: any, opts: any): any {
  const c = cfg || {};
  const o = opts || {};
  const cOpts = c.options || {};
  const oOpts = o.options || {};
  return {
    ...c,
    ...o,
    options: {
      ...cOpts,
      ...oOpts,
      cors: { ...(cOpts.cors || {}), ...(oOpts.cors || {}) },
    },
  };
}

/**
 * Whether a merged WebSocket config asks for compression: `compression: true`
 * on the section, or among its adapter options, where an adapter reads it.
 * @internal
 */
export function wantsWebSocketCompression(wsConfig: any): boolean {
  return wsConfig?.compression === true || wsConfig?.options?.compression === true;
}
