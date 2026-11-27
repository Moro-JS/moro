// HTTP/2 Server Implementation for Moro Framework
//
// `node:http2` and `node:zlib` are resolved on first use, not at import time.
// framework.ts imports this module unconditionally (it has to - the HTTP/2
// branch is chosen at construction), but the vast majority of apps never take
// that branch. Loading node:http2 eagerly costs every app ~1 MB RSS on top of
// http/https, and the zlib compressors another ~0.3 MB, for code they never
// run. Builtins are always synchronously requirable on every supported Node,
// so this needs no dynamic import and no engines bump.
import type {
  Http2Server,
  Http2SecureServer,
  ServerHttp2Session,
  ServerHttp2Stream,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from 'http2';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { createRequire } from 'module';
import { isMultipartMediaType } from './utils/body-type.js';
import { ALLOWED_METHODS, NOT_IMPLEMENTED_BODY, unroutedStatus } from './utils/unrouted.js';
import { promisify } from 'util';
import { createFrameworkLogger } from '../logger/index.js';
import {
  HttpRequest,
  HttpResponse,
  Middleware,
  HttpHandler,
  RouteEntry,
} from '../../types/http.js';
import { PathMatcher, literalPathPattern } from '../routing/path-matcher.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';
import { DEFAULT_IDLE_TIMEOUT_MS, type HttpRuntimeLimits } from './utils/size.js';
import { NODE_TLS_OPTION_KEYS } from './utils/ssl-config.js';
import { clientAddress, type ProxyTrust } from './utils/trust-proxy.js';
import { negotiateEncoding, type Encoding } from './utils/compression.js';
import { parseBufferedBody, payloadTooLarge, type BodyParseLimits } from './utils/body-parser.js';
import { dispatchMiddleware, WAIT_UNLESS_ANSWERED } from './utils/middleware-dispatch.js';
import {
  clearCookieOptions,
  serializeCookie,
  unsignedCookieError,
} from './utils/cookie-attributes.js';
import {
  clearRepresentationHeaders,
  destroyUnfinishedResponse,
  locationHeaderValue,
} from './utils/response-headers.js';
import { MoroHttpServer, MoroIncomingMessage, MoroServerResponse } from './http-server.js';

const NOT_IMPLEMENTED_BUFFER = Buffer.from(NOT_IMPLEMENTED_BODY);

// What this server's res.json() can produce, in preference order.
const HTTP2_JSON_ENCODINGS: Encoding[] = ['gzip', 'deflate'];

// Builtins only, so the base is irrelevant; 'file:///' keeps this compiling
// under the CJS transform Jest applies to the test suite (import.meta is a
// syntax error there).
const requireBuiltin = createRequire('file:///');

let http2Mod: typeof import('http2') | undefined;
function http2(): typeof import('http2') {
  return (http2Mod ??= requireBuiltin('http2') as typeof import('http2'));
}

let gzip: ((buf: Buffer) => Promise<Buffer>) | undefined;
let deflate: ((buf: Buffer) => Promise<Buffer>) | undefined;
let gzipSync: ((buf: Buffer) => Buffer) | undefined;
let deflateSync: ((buf: Buffer) => Buffer) | undefined;
function compressors() {
  if (!gzip) {
    const zlib = requireBuiltin('zlib') as typeof import('zlib');
    gzip = promisify(zlib.gzip) as (buf: Buffer) => Promise<Buffer>;
    deflate = promisify(zlib.deflate) as (buf: Buffer) => Promise<Buffer>;
    gzipSync = (buf: Buffer) => zlib.gzipSync(buf);
    deflateSync = (buf: Buffer) => zlib.deflateSync(buf);
  }
  return {
    gzip: gzip,
    deflate: deflate as (buf: Buffer) => Promise<Buffer>,
    gzipSync: gzipSync as (buf: Buffer) => Buffer,
    deflateSync: deflateSync as (buf: Buffer) => Buffer,
  };
}

export interface Http2ServerOptions {
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer | Array<string | Buffer>;
  // The rest of server.ssl, applied to the TLS listener as on the HTTPS server
  passphrase?: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Ask the client for a certificate (mutual TLS) */
  requestCert?: boolean;
  /** Refuse a client whose certificate does not verify against `ca` */
  rejectUnauthorized?: boolean;
  ciphers?: string;
  honorCipherOrder?: boolean;
  ecdhCurve?: string;
  sigalgs?: string;
  crl?: string | Buffer | Array<string | Buffer>;
  allowHTTP1?: boolean;
  maxSessionMemory?: number;
  maxBodySize?: number; // Maximum body size for JSON/form data
  maxUploadSize?: number; // Maximum size for file uploads
  /** Flattened runtime limits (timeouts, maxConnections, multipart, ...). */
  limits?: HttpRuntimeLimits;
  settings?: {
    headerTableSize?: number;
    /** Accepted for compatibility but never sent: RFC 9113 forbids a server from advertising ENABLE_PUSH=1 (clients drop the connection), and whether push is possible is the client's setting, read per stream. */
    enablePush?: boolean;
    initialWindowSize?: number;
    maxFrameSize?: number;
    maxConcurrentStreams?: number;
    maxHeaderListSize?: number;
    maxHeaderSize?: number;
    enableConnectProtocol?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Request and response objects.
//
// What every request needs is an own field set in the constructor. The
// Express-compatible helpers (req.get, req.hostname, res.sendFile, res.set,
// ...) are the Node server's own implementations, borrowed onto these
// prototypes once per process: one implementation, the same behaviour on
// both servers, and nothing allocated or defined per request for them. They
// only need what both kinds of object provide (headers, socket, setHeader,
// getHeader, end, ...).
// ---------------------------------------------------------------------------

// These objects were plain objects before they had prototypes, and anything
// could be assigned to them. An accessor the prototype adds keeps that true:
// assigning to it stores an own property, which then wins over the accessor.
function shadow(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** What req.socket answers once the HTTP/2 session is gone. */
function detachedSocket(req: Http2Request): Record<string, unknown> {
  return { encrypted: req._server.isSecure, remoteAddress: req._peer ?? req.ip, destroyed: true };
}

class Http2Request {
  /** Bound on the per-server subclass prototype */
  declare _server: MoroHttp2Server;
  declare method: string;
  declare path: string;
  declare url: string;
  declare query: Record<string, string>;
  declare params: Record<string, string>;
  declare headers: Record<string, string>;
  declare body: any;
  declare cookies: Record<string, string>;
  declare ip: string;
  /** The connected peer, kept apart from `ip` only when server.trustProxy is set */
  declare _peer: string | undefined;
  declare requestId: string;
  declare httpVersion: string;
  // The stream (push, events) and the headers as received, pseudo-headers included
  declare _http2Stream: ServerHttp2Stream;
  declare _http2Headers: IncomingHttpHeaders;

  constructor(
    method: string,
    url: string,
    headers: Record<string, string>,
    cookies: Record<string, string>,
    ip: string,
    requestId: string,
    stream: ServerHttp2Stream,
    rawHeaders: IncomingHttpHeaders
  ) {
    this.method = method;
    this.path = '';
    this.url = url;
    this.query = {};
    this.params = {};
    this.headers = headers;
    this.body = null;
    this.cookies = cookies;
    this.ip = ip;
    this.requestId = requestId;
    this.httpVersion = '2.0';
    this._http2Stream = stream;
    this._http2Headers = rawHeaders;
  }

  /**
   * The connection's socket, as on the Node server (`encrypted`,
   * `remoteAddress`, ...). Node exposes an HTTP/2 session's socket read-only:
   * reading is fine, writing to it or destroying it throws.
   */
  get socket(): any {
    const session = this._http2Stream.session;
    return session && !session.destroyed ? session.socket : detachedSocket(this);
  }
  set socket(value: any) {
    shadow(this, 'socket', value);
  }

  // The request's events are its stream's: 'close' when the stream is gone
  // (the client went away or the response finished), 'aborted', 'error'.
  on(event: string, listener: (...args: any[]) => void): this {
    this._http2Stream.on(event, listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    this._http2Stream.once(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this._http2Stream.off(event, listener);
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    this._http2Stream.off(event, listener);
    return this;
  }
}

class Http2Response {
  /** Bound on the per-server subclass prototype (logger, mime lookup) */
  declare _server: MoroHttp2Server;
  declare statusCode: number;
  declare headersSent: boolean;
  declare _headers: OutgoingHttpHeaders;
  declare _stream: ServerHttp2Stream;
  declare _req: HttpRequest;
  declare _logger: ReturnType<typeof createFrameworkLogger>;
  declare _poolManager: ObjectPoolManager;
  declare _compressionEnabled: boolean;
  declare _compressionThreshold: number;
  declare _compressionMaxInlineBytes: number;
  /** True between a head written on its own (writeHead, write) and end() */
  declare _headWritten: boolean | undefined;
  /** Listeners of 'finish', which the response emits itself (see _onFinish) */
  declare _finishListeners: Array<(...args: any[]) => void> | undefined;
  /** True once 'finish' has been emitted */
  declare _finished: boolean;
  // Assigned per request in createResponseFromStream
  declare writeHead: (status: number, headers?: OutgoingHttpHeaders) => this;

  constructor(
    stream: ServerHttp2Stream,
    req: HttpRequest,
    logger: ReturnType<typeof createFrameworkLogger>,
    poolManager: ObjectPoolManager,
    compressionEnabled: boolean,
    compressionThreshold: number,
    compressionMaxInlineBytes: number
  ) {
    this.statusCode = 200;
    this.headersSent = false;
    this._headers = {};
    this._stream = stream;
    this._req = req;
    this._logger = logger;
    this._poolManager = poolManager;
    this._compressionEnabled = compressionEnabled;
    this._compressionThreshold = compressionThreshold;
    this._compressionMaxInlineBytes = compressionMaxInlineBytes;
    this._finishListeners = undefined;
    this._finished = false;
  }

  /**
   * @internal Register a 'finish' listener. The response emits 'finish'
   * itself, once, when the whole response has been handed to the stream, and
   * always before 'close': what request logging, metrics and a rate limit's
   * refund wait for. The stream's own 'finish' cannot be relied on for that.
   * It fires for most responses, but a stream whose request body was read,
   * and one ended by its headers frame, can go from ended to closed without
   * it. So the first listener arms two things: the stream's 'finish', and a
   * check at 'close' that the response was ended and the stream was not
   * reset. An abandoned response (destroy(), a client that went away) emits
   * 'close' only, as a Node response does. Nothing is set up for a response
   * nobody listens to.
   */
  _onFinish(listener: (...args: any[]) => void, first = false): void {
    let listeners = this._finishListeners;
    if (listeners === undefined) {
      listeners = this._finishListeners = [];
      if (!this._finished) {
        const stream = this._stream;
        const finished = () => this._emitFinish();
        stream.once('finish', finished);
        stream.prependOnceListener('close', () => {
          // rstCode 0 is NO_ERROR: the stream ended, it was not reset
          if (stream.writableEnded && !stream.aborted && stream.rstCode === 0) finished();
        });
      }
    }
    if (first) listeners.unshift(listener);
    else listeners.push(listener);
  }

  /** @internal */
  _offFinish(listener: (...args: any[]) => void): void {
    const listeners = this._finishListeners;
    if (listeners === undefined) return;
    const at = listeners.indexOf(listener);
    if (at !== -1) listeners.splice(at, 1);
  }

  /** @internal Emit 'finish' unless it has been emitted. True when a listener ran. */
  _emitFinish(): boolean {
    if (this._finished) return false;
    this._finished = true;
    const listeners = this._finishListeners;
    if (listeners === undefined || listeners.length === 0) return false;
    this._finishListeners = [];
    for (let i = 0; i < listeners.length; i++) (listeners[i] as () => void)();
    return true;
  }

  /** The request this response answers (what the Node response calls `req`). */
  get req(): HttpRequest {
    return this._req;
  }
  set req(value: HttpRequest) {
    this._req = value;
  }

  /**
   * True once the response has been handed over in full: json(), send(),
   * end() or redirect() was called. False while a head written on its own
   * (writeHead, write) is still waiting for its end().
   */
  get writableEnded(): boolean {
    return this.headersSent && (!this._headWritten || this._stream.writableEnded);
  }
  set writableEnded(value: boolean) {
    shadow(this, 'writableEnded', value);
  }

  /**
   * Write a piece of the body, sending the head first if it has not gone
   * out. Returns false when the caller should wait for 'drain', as a Node
   * response does. A response that cannot carry a body (HEAD, 204, 304) is
   * complete with its head and the chunk is dropped.
   */
  write(chunk: string | Buffer, encoding?: any, callback?: any): boolean {
    const stream = this._stream;
    if (!this._headWritten) {
      // Already answered in one piece, or the stream is gone
      if (this.headersSent || stream.destroyed || stream.closed) return false;
      this.writeHead(this.statusCode);
      if (!this._headWritten) return true;
    }
    if (stream.destroyed || stream.closed) return false;
    return stream.write(chunk, encoding, callback);
  }

  /**
   * Abandon the response: the stream is reset with an internal error
   * (RST_STREAM), which the client sees as a failed transfer rather than a
   * complete one. The connection and its other streams are unaffected.
   * Destroying the stream with an error is what makes it a reset: close()
   * would end the body first, and the client would take what it has for the
   * whole response.
   */
  destroy(error?: Error): this {
    this.headersSent = true;
    this._headWritten = false;
    const stream = this._stream;
    if (!stream.destroyed) {
      stream.destroy(error ?? new Error('Response abandoned before it was complete'));
    }
    return this;
  }

  /** @internal Where sendFile() streams a file body: the head, then the stream. */
  _bodyStream(): NodeJS.WritableStream {
    if (!this._headWritten && !this.headersSent) this.writeHead(this.statusCode);
    return this._stream;
  }

  // on/once/off are assigned per request (they predate this class); these
  // complete the set a readable needs to pipe() into the response.
  emit(event: string, ...args: any[]): boolean {
    if (event === 'finish') return this._emitFinish();
    return this._stream.emit(event, ...args);
  }

  listenerCount(event: string): number {
    if (event === 'finish') return this._finishListeners?.length ?? 0;
    return this._stream.listenerCount(event);
  }

  prependListener(event: string, listener: (...args: any[]) => void): this {
    if (event === 'finish') this._onFinish(listener, true);
    else this._stream.prependListener(event, listener);
    return this;
  }
}

function borrow<T extends object>(target: object, source: T, names: Array<keyof T & string>): void {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor) Object.defineProperty(target, name, descriptor);
  }
}

borrow(Http2Request.prototype, MoroIncomingMessage.prototype, [
  'get',
  'header',
  'is',
  'accepts',
  'acceptsLanguages',
  'hostname',
  'protocol',
  'secure',
  'xhr',
  'ips',
  'subdomains',
  'originalUrl',
  'context',
]);

borrow(Http2Response.prototype, MoroServerResponse.prototype, [
  'sendFile',
  'download',
  'attachment',
  'set',
  'get',
  'append',
  'appendHeader',
  'type',
  'sendStatus',
  'location',
  'vary',
  'format',
  'links',
  'locals',
]);

// Connection-specific header fields have no meaning on an HTTP/2 connection
// and must not be sent on one (RFC 9113 8.2.2); Node refuses the whole
// response when one is present. Code written for HTTP/1.1 sets them routinely
// (`Connection: keep-alive` on an event stream), so they are dropped, as
// Node's own HTTP/2 compatibility layer drops `Connection`.
const CONNECTION_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
];

function dropConnectionHeaders(headers: OutgoingHttpHeaders): boolean {
  let dropped = false;
  for (let i = 0; i < CONNECTION_HEADERS.length; i++) {
    const name = CONNECTION_HEADERS[i] as string;
    if (headers[name] !== undefined) {
      delete headers[name];
      dropped = true;
    }
  }
  // TE is allowed with the one value "trailers"
  if (headers.te !== undefined && headers.te !== 'trailers') {
    delete headers.te;
    dropped = true;
  }
  return dropped;
}

const RESPOND_FAILED_BODY = Buffer.from('{"success":false,"error":"Internal server error"}');

/**
 * stream.respond() refused the head a handler built. Called from the catch
 * of the one place each kind of response is written, so the normal path pays
 * nothing for it. Connection-specific headers are dropped and the response
 * sent again; a head that still cannot be sent (a status outside 100-599, a
 * header name that is not a token) is answered with a 500 and logged, where
 * it used to close the stream with no response at all.
 *
 * `body` is ended with the head unless `keepOpen` (writeHead: the body
 * follows). Returns true when the head the handler asked for went out.
 */
function recoverRespond(
  res: Http2Response,
  error: unknown,
  bodiless: boolean,
  keepOpen: boolean,
  body?: Buffer | string
): boolean {
  const stream = res._stream;
  if (stream.destroyed || stream.closed) return false;
  if (stream.headersSent) {
    // The head went out; it was the body write that failed
    res._logger.debug('HTTP/2 response write failed', 'StreamError', {
      error: error instanceof Error ? error.message : String(error),
    });
    stream.close();
    return false;
  }

  let failure = error;
  if (dropConnectionHeaders(res._headers)) {
    try {
      if (bodiless) {
        stream.respond({ ':status': res.statusCode, ...res._headers }, { endStream: true });
      } else {
        stream.respond({ ':status': res.statusCode, ...res._headers });
        if (!keepOpen) stream.end(body ?? '');
      }
      return true;
    } catch (retryError) {
      failure = retryError;
    }
  }

  res._logger.error('HTTP/2 response could not be sent', 'StreamError', {
    error: failure instanceof Error ? failure.message : String(failure),
    status: res.statusCode,
    path: res._req.path,
  });
  try {
    const head = {
      ':status': 500,
      'content-type': 'application/json; charset=utf-8',
      'content-length': RESPOND_FAILED_BODY.length,
    };
    if (res._req.method === 'HEAD') {
      stream.respond(head, { endStream: true });
    } else {
      stream.respond(head);
      stream.end(RESPOND_FAILED_BODY);
    }
    res.statusCode = 500;
  } catch {
    if (!stream.destroyed) stream.close(http2().constants.NGHTTP2_INTERNAL_ERROR);
  }
  return false;
}

// An HTTP/1.1 client on the TLS port (it offered only http/1.1 in ALPN): this
// server speaks HTTP/2 only, so the request is refused in the protocol the
// client does speak instead of being left unanswered.
const HTTP1_REFUSAL =
  'This server only speaks HTTP/2. Retry the request over HTTP/2 (ALPN protocol "h2").\n';

function refuseHttp1(req: IncomingMessage, res: ServerResponse): void {
  // Not an HTTP/1 exchange: nothing to do with this listener
  if (req.httpVersionMajor >= 2 || typeof res.writeHead !== 'function') return;
  res.writeHead(505, {
    Connection: 'close',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(HTTP1_REFUSAL),
  });
  res.end(HTTP1_REFUSAL);
}

// A query component as today's decodeURIComponent gives it; one that is not
// valid percent-encoding is kept as received instead of failing the request.
function decodeQueryComponent(component: string): string {
  if (component.indexOf('%') === -1) return component;
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

export class MoroHttp2Server {
  private server: Http2Server | Http2SecureServer;
  private routes: RouteEntry[] = [];
  private globalMiddleware: Middleware[] = [];
  private compressionEnabled = true;
  private compressionThreshold = 1024;
  // Bodies at or below this size compress on the calling thread; 0 = never
  private compressionMaxInlineBytes = 16384;
  private requestTrackingEnabled = true;
  /** @internal read by the request getters: server.trustProxy, compiled (undefined = not set) */
  proxyTrust: ProxyTrust | undefined = undefined;
  /** Multipart and form limits threaded to parseBufferedBody at the call
   *  site; a limit that is absent is the parser's own default. */
  private bodyLimits: BodyParseLimits = {};
  private _limits?: HttpRuntimeLimits;
  private logger = createFrameworkLogger('Http2Server');
  private hookManager: any;
  private requestCounter = 0;
  /** @internal read by the request's socket getter */
  isSecure: boolean;
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;
  // Direct router dispatch slot, run after the app.use() chain (set from
  // Moro.listen via setRouterHandler)
  private routerHandler?: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>;

  // The router of the app this server belongs to (set by the framework when
  // it creates the server). Dispatch goes through routerHandler; this is for
  // code inside a request that needs the app's own router or configuration
  // and reaches the server through the request. Declared only: the property
  // exists once the framework sets it, and no other field moves for it.
  declare router?: import('../routing/unified-router.js').UnifiedRouter;

  // Per-server request/response classes; their prototype carries the
  // `_server` back-reference the borrowed helpers read (logger, mime lookup).
  private RequestClass: typeof Http2Request;
  private ResponseClass: typeof Http2Response;

  // Body size limits - defaults overridden by config in constructor
  private maxBodySize: number = 10 * 1024 * 1024; // Default 10MB (overridden by server.bodySizeLimit config)
  private maxUploadSize: number = 100 * 1024 * 1024; // Default 100MB for file uploads

  // Use shared object pool manager
  private poolManager = ObjectPoolManager.getInstance();

  // Interned method strings for fast comparison
  private static readonly METHOD_POST = 'POST';
  private static readonly METHOD_PUT = 'PUT';
  private static readonly METHOD_PATCH = 'PATCH';
  private static readonly METHOD_GET = 'GET';
  private static readonly METHOD_DELETE = 'DELETE';
  private static readonly METHOD_HEAD = 'HEAD';
  private static readonly METHOD_OPTIONS = 'OPTIONS';

  // Pre-compiled response templates
  private static readonly RESPONSE_TEMPLATES = {
    notFound: Buffer.from('{"success":false,"error":"Not found"}'),
    unauthorized: Buffer.from('{"success":false,"error":"Unauthorized"}'),
    forbidden: Buffer.from('{"success":false,"error":"Forbidden"}'),
    internalError: Buffer.from('{"success":false,"error":"Internal server error"}'),
    methodNotAllowed: Buffer.from('{"success":false,"error":"Method not allowed"}'),
    rateLimited: Buffer.from('{"success":false,"error":"Rate limit exceeded"}'),
  };

  // Route optimization structures
  private routeCache = new Map<string, RouteEntry | null>();
  private staticRoutes = new Map<string, RouteEntry>();
  private dynamicRoutes: RouteEntry[] = [];
  private routesBySegmentCount = new Map<number, RouteEntry[]>();
  // Routes with trailing optional parameters or a wildcard, in the order added
  private variableRoutes: RouteEntry[] = [];
  private pathNormalizationCache = new Map<string, string>();

  constructor(options: Http2ServerOptions = {}) {
    this.isSecure = !!(options.key && options.cert);

    class BoundRequest extends Http2Request {}
    class BoundResponse extends Http2Response {}
    BoundRequest.prototype._server = this;
    BoundResponse.prototype._server = this;
    this.RequestClass = BoundRequest;
    this.ResponseClass = BoundResponse;

    // Configure body size limits from options
    if (options.maxBodySize) {
      this.maxBodySize = options.maxBodySize;
    }
    if (options.maxUploadSize) {
      this.maxUploadSize = options.maxUploadSize;
    }
    if (options.limits?.multipart) this.bodyLimits.multipart = options.limits.multipart;
    if (options.limits?.form) this.bodyLimits.form = options.limits.form;
    if (options.limits) this._limits = options.limits;

    const serverOptions: any = {
      allowHTTP1: options.allowHTTP1 !== false,
      ...(options.maxSessionMemory && { maxSessionMemory: options.maxSessionMemory }),
    };

    // Add SSL options if secure: the certificate material and every policy
    // option of server.ssl (client certificates, version bounds, ciphers)
    if (this.isSecure) {
      for (const key of NODE_TLS_OPTION_KEYS) {
        const value = options[key];
        if (value !== undefined) serverOptions[key] = value;
      }
    }

    // Add HTTP/2 settings. SETTINGS_ENABLE_PUSH is never sent: RFC 9113
    // §6.5.2 forbids a server from advertising it as 1, and nghttp2 (curl,
    // Node's own client, browsers) treats that frame as a connection-level
    // PROTOCOL_ERROR - every stream died before its response could be read.
    // Whether push is possible is the CLIENT's setting, read per stream from
    // stream.pushAllowed, so settings.enablePush changes nothing on the wire.
    if (options.settings) {
      serverOptions.settings = {
        headerTableSize: options.settings.headerTableSize,
        initialWindowSize: options.settings.initialWindowSize || 65535,
        maxFrameSize: options.settings.maxFrameSize || 16384,
        maxConcurrentStreams: options.settings.maxConcurrentStreams || 100,
        maxHeaderListSize: options.settings.maxHeaderListSize,
        maxHeaderSize: options.settings.maxHeaderSize,
        enableConnectProtocol: options.settings.enableConnectProtocol,
      };
    } else {
      serverOptions.settings = {
        initialWindowSize: 65535,
        maxFrameSize: 16384,
        maxConcurrentStreams: 100,
      };
    }

    // Create server
    if (this.isSecure) {
      this.server = http2().createSecureServer(serverOptions);
      this.logger.info('HTTP/2 secure server created', 'ServerInit');
    } else {
      this.server = http2().createServer(serverOptions);
      this.logger.info('HTTP/2 server created', 'ServerInit');
    }

    // Configure server settings. A session on which no frame has moved in
    // either direction for the idle timeout is closed. An app built through
    // createApp() passes server.timeouts.idle, where unset means the default
    // and 0 disables; the 30s applies only when this class is constructed
    // without `limits`.
    this.server.setTimeout(
      options.limits?.timeouts?.idle ?? (options.limits ? DEFAULT_IDLE_TIMEOUT_MS : 30000)
    );
    // Left to itself Node destroys the session when the timer fires, and with
    // it every stream still open: a handler that takes longer than the idle
    // timeout to answer, or a stream with a longer gap between writes, would
    // be cut. Closing gracefully instead tells the client to use a new
    // connection (GOAWAY), lets the streams in progress finish, and ends the
    // session then; a session with no stream open ends at once, as before.
    // With allowHTTP1 the same event carries the socket of an HTTP/1.1 TLS
    // client: that one is destroyed, which is what Node does when nothing
    // listens.
    this.server.on('timeout', (idle: ServerHttp2Session | Socket) => {
      if (typeof (idle as ServerHttp2Session).goaway !== 'function') {
        (idle as Socket).destroy();
        return;
      }
      const session = idle as ServerHttp2Session;
      if (!session.closed && !session.destroyed) session.close();
    });
    if (options.limits?.maxConnections && options.limits.maxConnections > 0) {
      (this.server as any).maxConnections = options.limits.maxConnections;
    }

    // Handle streams (HTTP/2 requests). Wrap so the async handler's promise is
    // always caught - a rejection escaping here becomes an unhandled rejection
    // that can crash the process.
    this.server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      void this.handleStream(stream, headers).catch(error => {
        this.logger.error('Unhandled HTTP/2 stream error', 'StreamError', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    // With allowHTTP1 (the default) Node accepts a TLS client that negotiated
    // http/1.1 and parses its request, but this server only handles streams:
    // the request was never answered and the socket stayed open. Refuse it
    // properly instead. A 'request' listener also makes Node wrap every
    // HTTP/2 stream in its compatibility request/response objects and emit
    // 'request' for it; that second 'stream' listener is taken off again, so
    // HTTP/2 streams reach handleStream alone, exactly as before.
    if (this.isSecure && serverOptions.allowHTTP1) {
      const streamListeners = this.server.listeners('stream');
      this.server.on('request', refuseHttp1 as any);
      for (const listener of this.server.listeners('stream')) {
        if (!streamListeners.includes(listener)) {
          this.server.removeListener('stream', listener as (...args: any[]) => void);
        }
      }
    }

    // Handle session events
    this.server.on('session', session => {
      this.logger.debug('HTTP/2 session created', 'Session');

      session.on('error', err => {
        this.logger.error('HTTP/2 session error', 'Session', { error: err.message });
      });
    });

    // Handle server errors
    this.server.on('error', err => {
      this.logger.error('HTTP/2 server error', 'ServerError', { error: err.message });
    });
  }

  // Configure server for maximum performance
  configurePerformance(
    config: {
      compression?: { enabled: boolean; threshold?: number; maxInlineBytes?: number };
      minimal?: boolean;
    } = {}
  ) {
    if (config.compression !== undefined) {
      this.compressionEnabled = config.compression.enabled;
      if (config.compression.threshold !== undefined) {
        this.compressionThreshold = config.compression.threshold;
      }
      if (config.compression.maxInlineBytes !== undefined) {
        this.compressionMaxInlineBytes = config.compression.maxInlineBytes;
      }
    }

    if (config.minimal) {
      this.compressionEnabled = false;
      this.compressionThreshold = Infinity;
    }
  }

  // Configure request tracking
  setRequestTracking(enabled: boolean): void {
    this.requestTrackingEnabled = enabled;
  }

  /**
   * Apply server.trustProxy (compiled by compileTrustProxy). With undefined,
   * req.ip / req.ips / req.protocol / req.hostname are derived as they were
   * before the setting existed.
   */
  setTrustProxy(trust: ProxyTrust | undefined): void {
    this.proxyTrust = trust;
  }

  // Middleware management
  use(middleware: Middleware): void {
    // Defensive check: Don't add MiddlewareInterface objects to globalMiddleware
    // MiddlewareInterface objects should only be handled by MiddlewareManager
    if (
      middleware &&
      typeof middleware === 'object' &&
      (middleware as any).install &&
      (middleware as any).metadata
    ) {
      this.logger?.warn?.(
        `Attempted to add MiddlewareInterface "${(middleware as any).metadata?.name}" to HTTP server globalMiddleware. ` +
          `This should be handled by MiddlewareManager instead. Skipping.`,
        'Middleware'
      );
      return;
    }

    this.globalMiddleware.push(middleware);
  }

  // Set hooks manager
  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  // Direct router dispatch, as on the Node server: called after the app.use()
  // chain and before the direct route table. Returning true (or a promise of
  // true) means the router took the request, whether or not it has answered
  // yet. Without this the router ran as one more middleware, which cannot
  // say that: a handler that answers later from a callback (a timer, a pipe)
  // looked unhandled and was run a second time from the direct route table.
  setRouterHandler(fn: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>): void {
    this.routerHandler = fn;
  }

  // Register a global error handler (called from Moro.setErrorHandler), given
  // first shot at a failed request before the default error response, as on
  // the Node server.
  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): void {
    this.errorHandler = fn;
  }

  /** @internal called by the borrowed response helpers (res.sendFile, res.attachment) */
  getMimeType(ext: string): Promise<string> {
    return MoroHttpServer.prototype.getMimeType.call(this, ext);
  }

  /** @internal called by the borrowed response helpers (res.sendFile) */
  addCharsetIfNeeded(mimeType: string): string {
    return MoroHttpServer.prototype.addCharsetIfNeeded.call(this, mimeType);
  }

  // Routing methods
  get(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('GET', path, handlers);
  }

  post(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('POST', path, handlers);
  }

  put(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('PUT', path, handlers);
  }

  delete(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('DELETE', path, handlers);
  }

  patch(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('PATCH', path, handlers);
  }

  private addRoute(method: string, path: string, handlers: (Middleware | HttpHandler)[]): void {
    const { pattern, paramNames } = this.pathToRegex(path);
    const handler = handlers.pop() as HttpHandler;
    const middleware = handlers as Middleware[];

    const route = {
      method,
      path,
      pattern,
      paramNames,
      handler,
      middleware,
    };

    this.routes.push(route);

    // Organize routes for optimal lookup
    if (paramNames.length === 0) {
      const staticKey = `${method}:${path}`;
      this.staticRoutes.set(staticKey, route);
    } else {
      this.dynamicRoutes.push(route);
      // Trailing optional parameters or a wildcard: the request paths such a
      // route matches have no one segment count
      if (PathMatcher.compile(path).variableLength) {
        this.variableRoutes.push(route);
        return;
      }
      const segmentCount = PathMatcher.countSegments(path);
      if (!this.routesBySegmentCount.has(segmentCount)) {
        this.routesBySegmentCount.set(segmentCount, []);
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.routesBySegmentCount.get(segmentCount)!.push(route);
    }
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const compiled = PathMatcher.compile(path);
    return {
      pattern: compiled.pattern || literalPathPattern(path),
      paramNames: compiled.paramNames,
    };
  }

  private async handleStream(
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders
  ): Promise<void> {
    this.requestCounter++;

    // Every stream needs an 'error' listener: a peer can reset a stream at any
    // time (RST_STREAM with an error code while the response is still queued,
    // for one), and an 'error' event with no listener is an uncaught exception
    // that takes the whole process down. The request is over either way.
    stream.on('error', (error: Error) => {
      this.logger.debug('HTTP/2 stream error', 'StreamError', { error: error.message });
    });

    const httpReq = this.createRequestFromStream(stream, headers);
    const httpRes = this.createResponseFromStream(stream, httpReq);

    try {
      // Parse URL and query
      const url = (headers[':path'] as string) || '/';
      const queryIndex = url.indexOf('?');

      if (queryIndex === -1) {
        httpReq.path = url;
        httpReq.query = {};
      } else {
        httpReq.path = url.substring(0, queryIndex);
        httpReq.query = this.parseQueryString(url.substring(queryIndex + 1));
      }

      // Parse body for POST/PUT/PATCH
      const method = httpReq.method;
      if (
        method === MoroHttp2Server.METHOD_POST ||
        method === MoroHttp2Server.METHOD_PUT ||
        method === MoroHttp2Server.METHOD_PATCH
      ) {
        httpReq.body = await this.parseBody(stream, headers);
      }

      // Execute hooks
      if (this.hookManager) {
        await this.hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });

        // Post-response hooks. The HTTP/2 response object is a plain object
        // (no event emitter), so listen on the underlying stream instead.
        if (this.hookManager.hasHooks === undefined || this.hookManager.hasHooks('response')) {
          stream.once('close', () => {
            void Promise.resolve(
              this.hookManager.execute('response', { request: httpReq, response: httpRes })
            ).catch((error: any) =>
              this.logger?.error?.(`Response hook error: ${error?.message || error}`, 'Hooks')
            );
          });
        }
      }

      // A request hook may answer the request itself (rate limiting, auth
      // rejection). Registration of the response hooks above still stands.
      if (httpRes.headersSent) return;

      // Execute global middleware
      if (this.globalMiddleware.length > 0) {
        await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
      }

      // If middleware handled the request, don't continue
      if (httpRes.headersSent) {
        return;
      }

      // Unified router direct dispatch
      const routerHandler = this.routerHandler;
      if (routerHandler) {
        const handled = routerHandler(httpReq, httpRes);
        if (handled) {
          if (typeof (handled as any).then === 'function') {
            if (await handled) return;
          } else {
            return;
          }
        }
        if (httpRes.headersSent) return;
      }

      // Find matching route (path is always set after URL parsing)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const route = this.findRoute(method || MoroHttp2Server.METHOD_GET, httpReq.path!);
      if (!route) {
        // The reply to a request nothing answered (unroutedStatus).
        const status = unroutedStatus(method, httpReq.path);
        if (status === 204) {
          httpRes.statusCode = 204;
          httpRes.setHeader('Allow', ALLOWED_METHODS);
          httpRes.end();
          return;
        }
        const body =
          status === 501 ? NOT_IMPLEMENTED_BUFFER : MoroHttp2Server.RESPONSE_TEMPLATES.notFound;
        httpRes.statusCode = status;
        httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
        httpRes.setHeader('Content-Length', body.length);
        httpRes.end(body);
        return;
      }

      // Extract path parameters
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const matches = httpReq.path!.match(route.pattern);
      if (matches) {
        httpReq.params = this.poolManager.acquireParams();
        const paramNames = route.paramNames;
        for (let i = 0; i < paramNames.length; i++) {
          const paramName = paramNames[i];
          const value = matches[i + 1];
          if (paramName !== undefined && value !== undefined) {
            httpReq.params[paramName] = value;
          }
        }
      }

      // Execute route middleware
      if (route.middleware.length > 0) {
        await this.executeMiddleware(route.middleware, httpReq, httpRes);
      }

      // Execute handler
      const handlerResult = route.handler(httpReq, httpRes);
      if (handlerResult && typeof handlerResult.then === 'function') {
        await handlerResult;
      }
    } catch (error) {
      await this.onStreamError(error, httpReq, httpRes);
    } finally {
      // Release pooled objects
      if (httpReq.params && Object.keys(httpReq.params).length === 0) {
        this.poolManager.releaseParams(httpReq.params);
      }
      if (httpReq.query && Object.keys(httpReq.query).length === 0) {
        this.poolManager.releaseQuery(httpReq.query);
      }
    }
  }

  // The error path of a request, in the Node server's order and with its
  // statuses and bodies: 413 for a body over its limit, then the app's error
  // handler, then the default 400 (a body that could not be parsed) or 500.
  // Never throws.
  private async onStreamError(
    error: unknown,
    httpReq: HttpRequest,
    httpRes: HttpResponse
  ): Promise<void> {
    // Error hooks are observational: fire-and-forget so a slow or throwing
    // observer can never delay or alter the error response.
    if (
      this.hookManager &&
      (this.hookManager.hasHooks === undefined || this.hookManager.hasHooks('error'))
    ) {
      void Promise.resolve(
        this.hookManager.execute('error', { request: httpReq, response: httpRes, error })
      ).catch((hookError: any) =>
        this.logger?.error?.(`Error hook error: ${hookError?.message || hookError}`, 'Hooks')
      );
    }

    try {
      if ((error as any)?.statusCode === 413 && !httpRes.headersSent) {
        httpRes.statusCode = 413;
        void httpRes.json({ success: false, error: 'Request entity too large' });
        return;
      }

      this.logger.error('HTTP/2 stream error', 'StreamError', {
        error: error instanceof Error ? error.message : String(error),
        requestId: httpReq.requestId,
        path: httpReq.path,
      });

      if (this.errorHandler && !httpRes.headersSent) {
        try {
          const handlerResult = this.errorHandler(error, httpReq, httpRes);
          if (handlerResult && typeof (handlerResult as any).then === 'function') {
            await handlerResult;
          }
          if (httpRes.headersSent) return;
        } catch (handlerErr) {
          this.logger.error('Error handler itself threw', 'StreamError', {
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        }
      }

      if (httpRes.headersSent) {
        // The failure came after the response had started: nothing can be
        // answered any more, and an open stream would keep the client waiting.
        destroyUnfinishedResponse(httpRes);
        return;
      }

      const isBadRequest = (error as any)?.statusCode === 400;
      // What the handler had set described the body it meant to send
      clearRepresentationHeaders(httpRes);
      void httpRes.status(isBadRequest ? 400 : 500).json({
        success: false,
        error: isBadRequest ? 'Invalid request body' : 'Internal server error',
        requestId: httpReq.requestId,
      });
    } catch (fatalError) {
      this.logger.error('Failed while handling request error', 'StreamError', {
        error: fatalError instanceof Error ? fatalError.message : String(fatalError),
      });
    }
  }

  private createRequestFromStream(
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders
  ): HttpRequest {
    // Extract method from pseudo-header
    const methodRaw = ((headers[':method'] as string) || 'GET').toUpperCase();

    // Intern method string for fast comparison
    let method: string;
    switch (methodRaw) {
      case 'POST':
        method = MoroHttp2Server.METHOD_POST;
        break;
      case 'PUT':
        method = MoroHttp2Server.METHOD_PUT;
        break;
      case 'PATCH':
        method = MoroHttp2Server.METHOD_PATCH;
        break;
      case 'GET':
        method = MoroHttp2Server.METHOD_GET;
        break;
      case 'DELETE':
        method = MoroHttp2Server.METHOD_DELETE;
        break;
      case 'HEAD':
        method = MoroHttp2Server.METHOD_HEAD;
        break;
      case 'OPTIONS':
        method = MoroHttp2Server.METHOD_OPTIONS;
        break;
      default:
        method = methodRaw;
    }

    // Convert HTTP/2 headers to standard headers (remove pseudo-headers)
    const standardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!key.startsWith(':')) {
        standardHeaders[key] = Array.isArray(value) ? value.join(', ') : (value as string);
      }
    }

    // Parse cookies
    const cookieHeader = standardHeaders['cookie'];
    const cookies: Record<string, string> = {};
    if (cookieHeader) {
      const cookieParts = cookieHeader.split(';');
      for (const cookie of cookieParts) {
        const equalIndex = cookie.indexOf('=');
        if (equalIndex > 0) {
          const name = cookie.substring(0, equalIndex).trim();
          const value = cookie.substring(equalIndex + 1);
          if (name && value) {
            try {
              cookies[name] = decodeURIComponent(value);
            } catch {
              // Malformed percent-encoding: keep the raw value rather than
              // throwing a URIError. createRequestFromStream runs before
              // handleStream's try block, so an escape here would surface as
              // an unhandled rejection and crash the process.
              cookies[name] = value;
            }
          }
        }
      }
    }

    // An HTTP/2 client names the host in :authority and sends no Host header
    // (RFC 9113 8.3.1). req.headers.host, and everything derived from it
    // (req.hostname, req.subdomains), reads the same as on HTTP/1.1.
    if (standardHeaders.host === undefined) {
      const authority = headers[':authority'];
      if (typeof authority === 'string' && authority !== '') standardHeaders.host = authority;
    }

    // req.ip: the connected peer, or with server.trustProxy the client as the
    // trusted proxies report it
    const peer: string = (stream.session?.socket as any)?.remoteAddress || '';
    const trust = this.proxyTrust;
    const ip =
      trust !== undefined ? clientAddress(peer, standardHeaders['x-forwarded-for'], trust) : peer;

    // The stream and the received headers ride along for push and events
    const request = new this.RequestClass(
      method,
      (headers[':path'] as string) || '/',
      standardHeaders,
      cookies,
      ip,
      this.requestTrackingEnabled ? this.poolManager.generateRequestId() : '',
      stream,
      headers
    );
    // req.socket still answers with the peer once the session is gone
    if (trust !== undefined) request._peer = peer;
    return request as unknown as HttpRequest;
  }

  private createResponseFromStream(stream: ServerHttp2Stream, req: HttpRequest): HttpResponse {
    const httpRes: any = new this.ResponseClass(
      stream,
      req,
      this.logger,
      this.poolManager,
      this.compressionEnabled,
      this.compressionThreshold,
      this.compressionMaxInlineBytes
    );

    // Status method
    httpRes.status = (code: number) => {
      httpRes.statusCode = code;
      return httpRes;
    };

    // Set header
    httpRes.setHeader = (name: string, value: string | string[]) => {
      httpRes._headers[name.toLowerCase()] = value;
      return httpRes;
    };

    // Get header
    httpRes.getHeader = (name: string) => {
      return httpRes._headers[name.toLowerCase()];
    };

    // Remove header
    httpRes.removeHeader = (name: string) => {
      delete httpRes._headers[name.toLowerCase()];
      return httpRes;
    };

    // Has header
    httpRes.hasHeader = (name: string): boolean => {
      return httpRes._headers[name.toLowerCase()] !== undefined;
    };

    // Get headers
    httpRes.getHeaders = () => {
      return { ...httpRes._headers };
    };

    // Event surface for middleware written against Node's ServerResponse -
    // the built-in request logger, Prometheus, CloudWatch and performance
    // monitors all call res.on('finish', ...). This response is a plain
    // object, so its events are the stream's ('close' when the stream is
    // gone, 'drain', 'error'), except 'finish', which the response emits
    // itself so that every completed response has one (see _onFinish).
    // Without these, enabling request logging (the default) turned every
    // HTTP/2 request into a 500.
    httpRes.on = (event: string, listener: (...args: any[]) => void) => {
      if (event === 'finish') httpRes._onFinish(listener);
      else stream.on(event, listener);
      return httpRes;
    };
    // 'finish' is emitted once, so once() and on() are the same for it
    httpRes.once = (event: string, listener: (...args: any[]) => void) => {
      if (event === 'finish') httpRes._onFinish(listener);
      else stream.once(event, listener);
      return httpRes;
    };
    httpRes.off = httpRes.removeListener = (event: string, listener: (...args: any[]) => void) => {
      if (event === 'finish') httpRes._offFinish(listener);
      else stream.off(event, listener);
      return httpRes;
    };

    // The one place that writes the response. It marks the response sent
    // BEFORE touching the stream, so a second helper call or a late async
    // continuation can never respond twice, and it never lets a stream error
    // escape. A response that must not carry a body (HEAD, 1xx, 204, 205, 304)
    // is ended by the headers frame itself: respond() already closes the
    // stream for those, and a following end() is a write-after-end error.
    // A head respond() refuses is dealt with in recoverRespond.
    const commit = (body?: Buffer | string) => {
      httpRes.headersSent = true;
      if (stream.destroyed || stream.closed) return;

      const status = httpRes.statusCode;
      const bodiless =
        req.method === 'HEAD' || status === 204 || status === 205 || status === 304 || status < 200;
      // A 204/205 must not declare a length for a body it cannot have.
      if (status === 204 || status === 205) delete httpRes._headers['content-length'];

      try {
        if (bodiless) {
          stream.respond({ ':status': status, ...httpRes._headers }, { endStream: true });
        } else {
          stream.respond({ ':status': status, ...httpRes._headers });
          stream.end(body ?? '');
        }
      } catch (error) {
        // The stream went away between the check above and the write, or the
        // handler set a status or header HTTP/2 cannot send.
        recoverRespond(httpRes, error, bodiless, false, body);
      }
    };

    // JSON response. Synchronous unless the body is large enough to be
    // compressed off-thread; a serialisation error throws to the caller.
    httpRes.json = (data: any): void | Promise<void> => {
      if (httpRes.headersSent || stream.destroyed) return;

      const jsonString = JSON.stringify(data);
      // Nothing to serialise (undefined, a function): an empty body with the
      // JSON content type and the status that was set.
      const finalBuffer = Buffer.from(jsonString === undefined ? '' : jsonString, 'utf8');

      httpRes._headers['content-type'] = 'application/json; charset=utf-8';

      // Compression
      if (httpRes._compressionEnabled && finalBuffer.length > httpRes._compressionThreshold) {
        // Honours q-values: `gzip;q=0` is a refusal, not a request.
        const encoding = negotiateEncoding(
          req.headers['accept-encoding'] as string | undefined,
          HTTP2_JSON_ENCODINGS
        );

        if (encoding === 'gzip' || encoding === 'deflate') {
          const sendCompressed = (compressed: Buffer) => {
            httpRes._headers['content-encoding'] = encoding;
            httpRes._headers['content-length'] = compressed.length;
            commit(compressed);
          };
          const sendIdentity = () => {
            httpRes._headers['content-length'] = finalBuffer.length;
            commit(finalBuffer);
          };

          // A small body is compressed on this thread (see compressionMaxInlineBytes)
          if (
            httpRes._compressionMaxInlineBytes > 0 &&
            finalBuffer.length <= httpRes._compressionMaxInlineBytes
          ) {
            sendCompressed(
              encoding === 'gzip'
                ? compressors().gzipSync(finalBuffer)
                : compressors().deflateSync(finalBuffer)
            );
            return;
          }

          // Off-thread compression: the response is committed from here on, so
          // nothing else may answer while it is in flight. The returned promise
          // never rejects - a compression failure falls back to the plain body.
          httpRes.headersSent = true;
          const pending: Promise<Buffer> =
            encoding === 'gzip'
              ? compressors().gzip(finalBuffer)
              : compressors().deflate(finalBuffer);
          return pending.then(sendCompressed, sendIdentity);
        }
      }

      httpRes._headers['content-length'] = finalBuffer.length;
      commit(finalBuffer);
    };

    // Send response
    httpRes.send = (data: string | Buffer) => {
      if (httpRes.headersSent || stream.destroyed) return;

      if (!httpRes._headers['content-type']) {
        // The same sniff the engine and Node servers use: a body that starts
        // with '{' or '[' is JSON, anything else text. Parsing the whole body
        // to decide cost a JSON.parse per response and labelled a bare number
        // or `true` as JSON.
        if (typeof data === 'string') {
          httpRes._headers['content-type'] = /^\s*[{[]/.test(data)
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8';
        } else {
          httpRes._headers['content-type'] = 'application/octet-stream';
        }
      }

      const buffer = typeof data === 'string' ? Buffer.from(data) : data;
      httpRes._headers['content-length'] = buffer.length;

      commit(buffer);
    };

    // writeHead: commit status and headers now, body to follow through end().
    // Middleware written against Node's ServerResponse relies on it - the
    // built-in compression middleware commits the head before compressing
    // off-thread, and without this method every such response was a 500.
    httpRes.writeHead = (status: number, headers?: OutgoingHttpHeaders) => {
      if (httpRes.headersSent || stream.destroyed) return httpRes;

      httpRes.statusCode = status;
      if (headers) {
        for (const name of Object.keys(headers)) {
          httpRes._headers[name.toLowerCase()] = headers[name];
        }
      }

      const bodiless =
        req.method === 'HEAD' || status === 204 || status === 205 || status === 304 || status < 200;
      if (bodiless) {
        commit();
        return httpRes;
      }

      httpRes.headersSent = true;
      try {
        stream.respond({ ':status': status, ...httpRes._headers });
        httpRes._headWritten = true;
      } catch (error) {
        if (recoverRespond(httpRes, error, false, true)) httpRes._headWritten = true;
      }
      return httpRes;
    };

    // End response
    httpRes.end = (data?: any) => {
      // Head already committed by writeHead(): this call carries the body.
      if (httpRes._headWritten) {
        httpRes._headWritten = false;
        if (!stream.destroyed && !stream.closed) {
          try {
            // No empty chunk: an empty final write queued behind data that
            // has already been flushed is never completed by the HTTP/2
            // stream, which then stays open (and its session with it) after
            // the client has the whole response.
            if (data === undefined || data === null || data.length === 0) stream.end();
            else stream.end(data);
          } catch (error) {
            httpRes._logger?.debug?.('HTTP/2 response write failed', 'StreamError', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return httpRes;
      }

      if (httpRes.headersSent || stream.destroyed) return httpRes;

      commit(data || '');
      return httpRes;
    };

    // Standardized response helpers
    httpRes.success = <T = any>(data: T, message?: string) => {
      const response: any = {
        success: true,
        data,
      };
      if (message !== undefined) {
        response.message = message;
      }
      httpRes.json(response);
    };

    httpRes.error = (error: string, code?: string, message?: string) => {
      const response: any = {
        success: false,
        error,
      };
      if (code !== undefined) {
        response.code = code;
      }
      if (message !== undefined) {
        response.message = message;
      }
      httpRes.json(response);
    };

    // Common HTTP error helpers (automatically set status code)
    httpRes.unauthorized = (message: string = 'Authentication required') => {
      httpRes.statusCode = 401;
      httpRes.json({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message,
      });
    };

    httpRes.forbidden = (message: string = 'Insufficient permissions') => {
      httpRes.statusCode = 403;
      httpRes.json({
        success: false,
        error: 'Forbidden',
        code: 'FORBIDDEN',
        message,
      });
    };

    httpRes.notFound = (resource: string = 'Resource') => {
      httpRes.statusCode = 404;
      httpRes.json({
        success: false,
        error: 'Not Found',
        code: 'NOT_FOUND',
        message: `${resource} not found`,
      });
    };

    httpRes.badRequest = (message: string = 'Invalid request') => {
      httpRes.statusCode = 400;
      httpRes.json({
        success: false,
        error: 'Bad Request',
        code: 'BAD_REQUEST',
        message,
      });
    };

    httpRes.conflict = (message: string) => {
      httpRes.statusCode = 409;
      httpRes.json({
        success: false,
        error: 'Conflict',
        code: 'CONFLICT',
        message,
      });
    };

    httpRes.internalError = (message: string = 'Internal server error') => {
      httpRes.statusCode = 500;
      httpRes.json({
        success: false,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message,
      });
    };

    httpRes.validationError = (
      errors: Array<{ field: string; message: string; code?: string }>
    ) => {
      httpRes.statusCode = 422;
      httpRes.json({
        success: false,
        error: 'Validation Failed',
        code: 'VALIDATION_ERROR',
        errors,
      });
    };

    httpRes.rateLimited = (retryAfter?: number) => {
      httpRes.statusCode = 429;
      if (retryAfter) {
        httpRes.setHeader('Retry-After', retryAfter.toString());
      }
      httpRes.json({
        success: false,
        error: 'Rate Limit Exceeded',
        code: 'RATE_LIMITED',
        message: retryAfter
          ? `Too many requests. Retry after ${retryAfter} seconds.`
          : 'Too many requests',
        retryAfter,
      });
    };

    // Common success patterns
    httpRes.created = <T = any>(data: T, location?: string) => {
      httpRes.statusCode = 201;
      if (location) {
        httpRes.setHeader('Location', location);
      }
      httpRes.json({
        success: true,
        data,
      });
    };

    httpRes.noContent = () => {
      httpRes.statusCode = 204;
      httpRes.end();
    };

    httpRes.paginated = <T = any>(
      data: T[],
      pagination: { page: number; limit: number; total: number }
    ) => {
      const totalPages = Math.ceil(pagination.total / pagination.limit);
      httpRes.json({
        success: true,
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total: pagination.total,
          totalPages,
          hasNext: pagination.page < totalPages,
          hasPrev: pagination.page > 1,
        },
      });
    };

    // Cookie handling
    httpRes.cookie = (name: string, value: string, options: any = {}) => {
      if (httpRes.headersSent) {
        const isCritical = options.critical || name.includes('session') || name.includes('auth');
        const message = `Cookie '${name}' could not be set - headers already sent`;

        if (isCritical || options.throwOnLateSet) {
          throw new Error(`${message}. This may cause authentication or security issues.`);
        } else {
          httpRes._logger.warn(message, 'CookieWarning', { cookieName: name });
        }
        return httpRes;
      }

      // Signing is done by the cookie middleware, which replaces this method.
      // Reaching here with `signed` means no signer is registered, and the
      // value must not go out unsigned under a name the application trusts.
      if (options.signed) throw unsignedCookieError(name);

      const cookieString = serializeCookie(name, value, options, req);

      const existingCookies = httpRes._headers['set-cookie'] || [];
      const cookies = Array.isArray(existingCookies)
        ? existingCookies
        : [existingCookies as string];
      cookies.push(cookieString);
      httpRes._headers['set-cookie'] = cookies;

      return httpRes;
    };

    // Clear cookie
    httpRes.clearCookie = (name: string, options: any = {}) => {
      return httpRes.cookie(name, '', clearCookieOptions(options));
    };

    // Redirect
    httpRes.redirect = (url: string, status: number = 302) => {
      if (httpRes.headersSent || stream.destroyed) return;

      httpRes.statusCode = status;
      // CR/LF stripped and non-ASCII percent-encoded, as the Node server does:
      // HTTP/2 drops a header value holding a line break without a word (a
      // redirect with no Location) and mangles one beyond Latin-1.
      httpRes._headers['location'] = locationHeaderValue(url);

      commit();
    };

    // HTTP/2 Server Push
    httpRes.push = (
      path: string,
      options: { headers?: OutgoingHttpHeaders; priority?: number } = {}
    ) => {
      if (httpRes.headersSent || stream.destroyed || !stream.pushAllowed) {
        return null;
      }

      try {
        const pushHeaders: any = {
          ':path': path,
          ':method': 'GET',
          ...options.headers,
        };

        const pushStream = stream.pushStream(pushHeaders, err => {
          if (err) {
            httpRes._logger.debug('Server push failed', 'ServerPush', {
              path,
              error: err.message,
            });
          }
        });

        // Set stream priority if specified
        if (options.priority !== undefined && pushStream) {
          try {
            // Priority weight: 1-256 (default 16)
            // Higher values = higher priority
            const weight = Math.max(1, Math.min(256, options.priority));
            (pushStream as any).priority({
              parent: 0,
              weight,
              exclusive: false,
            });
          } catch (error) {
            httpRes._logger.debug('Failed to set stream priority', 'StreamPriority', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return pushStream;
      } catch (error) {
        httpRes._logger.debug('Server push error', 'ServerPush', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    // Set stream priority for current response
    httpRes.setPriority = (
      options: { parent?: number; weight?: number; exclusive?: boolean } = {}
    ) => {
      if (httpRes.headersSent || stream.destroyed) {
        return httpRes;
      }

      try {
        stream.priority({
          parent: options.parent || 0,
          weight: options.weight ? Math.max(1, Math.min(256, options.weight)) : 16,
          exclusive: options.exclusive || false,
        });
      } catch (error) {
        httpRes._logger.debug('Failed to set stream priority', 'StreamPriority', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return httpRes;
    };

    // Set bulk headers
    httpRes.setBulkHeaders = (headers: Record<string, string | number>) => {
      if (httpRes.headersSent) {
        httpRes._logger.warn('Cannot set headers - headers already sent', 'HeaderWarning');
        return httpRes;
      }

      for (const key in headers) {
        httpRes._headers[key.toLowerCase()] = String(headers[key]);
      }
      return httpRes;
    };

    // Response state
    httpRes.canSetHeaders = (): boolean => {
      return !httpRes.headersSent;
    };

    httpRes.getResponseState = () => {
      return {
        headersSent: httpRes.headersSent,
        statusCode: httpRes.statusCode,
        headers: httpRes.getHeaders(),
        finished: stream.destroyed,
        writable: !stream.destroyed,
      };
    };

    return httpRes as HttpResponse;
  }

  private async parseBody(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<any> {
    const contentType = (headers['content-type'] as string) || '';
    const contentLength = parseInt((headers['content-length'] as string) || '0');

    // Use different limits based on content type
    const isMultipart = isMultipartMediaType(contentType);
    const maxSize = isMultipart
      ? this.maxUploadSize // Configurable file upload limit (default 100MB)
      : this.maxBodySize; // Configurable body size limit (default 10MB, from server.bodySizeLimit config)

    // A body declared over the limit is refused before any of it is read
    if (contentLength > maxSize) {
      return Promise.reject(payloadTooLarge('Request entity too large', maxSize, contentLength));
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLength = 0;

      stream.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          const errorMessage = isMultipart
            ? `File upload too large. Maximum ${Math.floor(maxSize / (1024 * 1024))}MB allowed.`
            : 'Request body too large';
          reject(payloadTooLarge(errorMessage, maxSize));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        try {
          // The Node server's parsing step, so the same bytes parse or fail
          // alike on both: an empty JSON body is null, a body that cannot be
          // parsed is a client error (400), a multipart or form limit a 413.
          // A body that is not JSON, a form or multipart is a string here.
          resolve(parseBufferedBody(Buffer.concat(chunks), contentType, this.bodyLimits, false));
        } catch (error) {
          reject(error);
        }
      });

      stream.on('error', reject);
    });
  }

  // Values that decode today decode exactly as before ('+' stays '+'); a
  // malformed percent-escape is kept as received instead of failing the
  // request.
  private parseQueryString(queryString: string): Record<string, string> {
    if (!queryString) return {};

    const result = this.poolManager.acquireQuery();
    const pairs = queryString.split('&');

    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      if (equalIndex === -1) {
        result[decodeQueryComponent(pair)] = '';
      } else {
        const key = decodeQueryComponent(pair.substring(0, equalIndex));
        const value = decodeQueryComponent(pair.substring(equalIndex + 1));
        result[key] = value;
      }
    }
    return result;
  }

  private normalizePath(path: string): string {
    if (this.pathNormalizationCache.has(path)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.pathNormalizationCache.get(path)!;
    }

    let normalized = path;
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    if (this.pathNormalizationCache.size < 200) {
      this.pathNormalizationCache.set(path, normalized);
    }

    return normalized;
  }

  private findRoute(method: string, path: string | undefined): RouteEntry | null {
    // Default to '/' if path is undefined
    const searchPath = path || '/';
    const cacheKey = `${method}:${searchPath}`;

    if (this.routeCache.has(cacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(cacheKey)!;
    }

    const normalizedPath = this.normalizePath(searchPath);
    const normalizedCacheKey =
      normalizedPath !== searchPath ? `${method}:${normalizedPath}` : cacheKey;

    if (normalizedPath !== path && this.routeCache.has(normalizedCacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(normalizedCacheKey)!;
    }

    const staticRoute = this.staticRoutes.get(normalizedCacheKey);
    if (staticRoute) {
      this.routeCache.set(normalizedCacheKey, staticRoute);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, staticRoute);
      }
      return staticRoute;
    }

    let route: RouteEntry | null = null;
    if (this.dynamicRoutes.length > 0) {
      const segmentCount = PathMatcher.countSegments(normalizedPath);
      const candidateRoutes = this.routesBySegmentCount.get(segmentCount) || this.dynamicRoutes;

      for (const candidateRoute of candidateRoutes) {
        if (candidateRoute.method === method && candidateRoute.pattern.test(normalizedPath)) {
          route = candidateRoute;
          break;
        }
      }
    }
    if (route === null && this.variableRoutes.length > 0) {
      for (const candidateRoute of this.variableRoutes) {
        if (candidateRoute.method === method && candidateRoute.pattern.test(normalizedPath)) {
          route = candidateRoute;
          break;
        }
      }
    }

    if (this.routeCache.size < 500) {
      this.routeCache.set(normalizedCacheKey, route);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, route);
      }
    }

    return route;
  }

  // The Node server's chain (utils/middleware-dispatch): next(err) and a
  // throw stop the request and reach the error path, and a four-parameter
  // error middleware runs only for a request that failed. A three-parameter
  // middleware that returns without having called next() or returned a
  // promise is waited for, as on the other servers: it will call next()
  // later, from a callback. One that answered the request instead ends the
  // chain, and the caller, which looks at res.headersSent, goes on to release
  // what the request held.
  private executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    return dispatchMiddleware(middleware, req, res, 0, undefined, WAIT_UNLESS_ANSWERED);
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, host?: string | (() => void), callback?: () => void): void {
    if (typeof host === 'function') {
      callback = host;
      host = undefined;
    }

    if (host) {
      this.server.listen(port, host, callback);
    } else {
      this.server.listen(port, callback);
    }
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => resolve());
    });
  }

  forceCleanup(): void {
    this.poolManager.clearAll();
    if (globalThis?.gc) {
      globalThis.gc();
    }
  }

  /**
   * Replace the TLS certificate/key for new handshakes (Http2SecureServer is
   * a tls.Server; setSecureContext applies to every later handshake).
   */
  updateSsl(ssl: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: Array<string | Buffer>;
    passphrase?: string;
    minVersion?: string;
    requestCert?: boolean;
    rejectUnauthorized?: boolean;
  }): void {
    const server = this.server as any;
    if (typeof server.setSecureContext !== 'function') {
      throw new Error('updateSsl: this server was not started with TLS (server.ssl)');
    }
    server.setSecureContext(ssl);
  }

  getServer(): Http2Server | Http2SecureServer {
    return this.server;
  }

  getPerformanceStats() {
    const poolStats = this.poolManager.getStats();
    return {
      paramObjectPoolSize: poolStats.paramPool.poolSize,
      queryObjectPoolSize: poolStats.queryPool.poolSize,
      headerObjectPoolSize: poolStats.headerPool.poolSize,
      poolManager: poolStats,
    };
  }
}
