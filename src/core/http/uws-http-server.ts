// uWebSockets.js HTTP Server Implementation for Moro Framework
// Provides high-performance HTTP and WebSocket server using uWebSockets.js

import cluster from 'cluster';
import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../logger/index.js';
import { HttpRequest, HttpResponse, Middleware } from '../../types/http.js';
import { loadNativeEngine, getNativeEngineLoadErrors } from '../utilities/package-utils.js';
import {
  parseMultipart as parseMultipartBuffer,
  type MultipartLimits,
} from './utils/multipart-parser.js';
import { LazyEventEmitter } from './utils/lazy-event-emitter.js';
import { parseRawQueryString } from './utils/query-parser.js';
import type { HttpRuntimeLimits } from './utils/size.js';
import {
  resolveCompressionSettings,
  compressBuffer,
  isCompressible,
  negotiateEncoding,
  type CompressionSettings,
} from './utils/compression.js';

// Back-compat alias (this parser is now the transport-neutral one in utils/)
const parseUwsQueryString = parseRawQueryString;

/**
 * Prototype-based request object for the uWS adapter.
 *
 * Headers/query/cookies/requestId are lazy: a synchronous handler that never
 * reads them pays nothing (no header copy, no UUID). The underlying uWS
 * request is only valid until the route callback returns to the event loop,
 * so `materialize()` MUST be called before any `await` - it snapshots the
 * headers and detaches the native reference.
 */
export class UwsRequest extends LazyEventEmitter {
  method: string;
  path: string;
  url: string;
  params: Record<string, string> = {};
  body: any = null;
  ip = '';

  _server: UWebSocketsHttpServer;
  _uwsReq: any; // valid ONLY synchronously inside the uWS route callback
  _queryString: string | null;
  _query: Record<string, string> | undefined = undefined;
  _headers: Record<string, string> | undefined = undefined;
  _cookies: Record<string, string> | undefined = undefined;
  _context: Record<string, any> | undefined = undefined;
  _requestId: string | undefined = undefined;
  _socket: any = undefined;

  constructor(
    server: UWebSocketsHttpServer,
    uwsReq: any,
    method: string,
    url: string,
    queryString: string
  ) {
    super();
    this._server = server;
    this._uwsReq = uwsReq;
    this.method = method;
    this.path = url;
    this.url = url;
    this._queryString = queryString || null;
  }

  // net.Socket-shaped shim so Node-style middleware (CSRF's req.socket.encrypted,
  // rate-limiters' req.connection.remoteAddress) doesn't throw on this transport.
  // uWS terminates plaintext HTTP here (TLS via its own listen options or a
  // proxy); scheme detection should use x-forwarded-proto.
  get socket(): any {
    let s = this._socket;
    if (s === undefined) {
      const getIp = () => this.ip; // arrow captures this lexically (no this-alias)
      s = {
        get remoteAddress() {
          return getIp() || undefined;
        },
        remotePort: undefined,
        encrypted: false,
        destroyed: false,
      };
      this._socket = s;
    }
    return s;
  }
  set socket(value: any) {
    this._socket = value;
  }

  get connection(): any {
    return this.socket;
  }
  set connection(value: any) {
    this._socket = value;
  }

  /** Snapshot uWS-backed data and detach the native request. Idempotent.
   *  Must be called before returning control to the event loop if the
   *  request object outlives the synchronous route callback. */
  materialize(): void {
    if (this._headers === undefined) {
      // Force the headers snapshot while the native request is still valid
      void this.headers;
    }
    this._uwsReq = null;
  }

  get headers(): Record<string, string> {
    let h = this._headers;
    if (h === undefined) {
      h = {};
      const r = this._uwsReq;
      if (r) {
        try {
          r.forEach((key: string, value: string) => {
            (h as Record<string, string>)[key] = value;
          });
        } catch {
          // Native request no longer valid - snapshot window was missed
        }
      }
      this._headers = h;
    }
    return h;
  }
  set headers(value: Record<string, string>) {
    this._headers = value;
  }

  get query(): Record<string, string> {
    let q = this._query;
    if (q === undefined) {
      const qs = this._queryString;
      q = qs ? parseUwsQueryString(qs) : {};
      this._query = q;
    }
    return q;
  }
  set query(value: Record<string, string>) {
    this._query = value;
  }

  get cookies(): Record<string, string> {
    let c = this._cookies;
    if (c === undefined) {
      c = {};
      const header = this.headers.cookie;
      if (header) {
        const parts = header.split(';');
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part === undefined) continue;
          const eq = part.indexOf('=');
          if (eq > 0) {
            const name = part.substring(0, eq).trim();
            const value = part.substring(eq + 1);
            if (name && value) {
              try {
                c[name] = decodeURIComponent(value);
              } catch {
                c[name] = value;
              }
            }
          }
        }
      }
      this._cookies = c;
    }
    return c;
  }
  set cookies(value: Record<string, string>) {
    this._cookies = value;
  }

  get context(): Record<string, any> {
    let ctx = this._context;
    if (ctx === undefined) {
      ctx = {};
      this._context = ctx;
    }
    return ctx;
  }
  set context(value: Record<string, any>) {
    this._context = value;
  }

  get requestId(): string {
    let id = this._requestId;
    if (id === undefined) {
      const server = this._server;
      id = server && (server as any).requestTrackingEnabled ? randomUUID() : '';
      this._requestId = id;
    }
    return id;
  }
  set requestId(value: string) {
    this._requestId = value;
  }

  // ==== Express-compatible request helpers (parity with the Node adapter) ====

  get hostname(): string {
    const host = this.headers.host || '';
    return host ? (host.split(':')[0] ?? '') : '';
  }

  get protocol(): string {
    const forwardedProto = this.headers['x-forwarded-proto'];
    if (forwardedProto) return (forwardedProto.split(',')[0] ?? '').trim();
    return this._server && (this._server as any).isSsl ? 'https' : 'http';
  }

  get secure(): boolean {
    return this.protocol === 'https';
  }

  get xhr(): boolean {
    const xrw = this.headers['x-requested-with'];
    return !!xrw && xrw.toLowerCase() === 'xmlhttprequest';
  }

  get originalUrl(): string {
    const qs = this._queryString;
    return qs ? `${this.url}?${qs}` : this.url;
  }

  get ips(): string[] {
    const forwardedFor = this.headers['x-forwarded-for'];
    return forwardedFor
      ? forwardedFor
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];
  }

  get subdomains(): string[] {
    const hostnameParts = this.hostname.split('.');
    return hostnameParts.length > 2 ? hostnameParts.slice(0, -2).reverse() : [];
  }

  get(name: string): string | undefined {
    const lower = name.toLowerCase();
    if (lower === 'referer' || lower === 'referrer') {
      return this.headers.referer || (this.headers as any).referrer;
    }
    return this.headers[lower];
  }

  header(name: string): string | undefined {
    return this.get(name);
  }

  is(type: string): boolean {
    const ct = this.headers['content-type'] || '';
    if (!ct) return false;
    const mime = (ct.split(';')[0] ?? '').trim().toLowerCase();
    const t = type.toLowerCase();
    if (t.indexOf('/') === -1) {
      return mime.endsWith(`/${t}`) || mime.endsWith(`+${t}`);
    }
    if (t.endsWith('/*')) {
      return mime.startsWith(t.slice(0, -1));
    }
    return mime === t;
  }

  accepts(types?: string | string[]): string | false {
    const accept = this.headers.accept || '*/*';
    if (!types) return accept;
    const wanted = Array.isArray(types) ? types : [types];
    if (accept === '*/*' || accept === '') return wanted[0] || false;
    const acceptTypes = accept.split(',').map(s => (s.split(';')[0] ?? '').trim().toLowerCase());
    for (const w of wanted) {
      const wl = w.toLowerCase();
      const wMime = wl.indexOf('/') === -1 ? `application/${wl}` : wl;
      for (const at of acceptTypes) {
        if (at === '*/*') return w;
        if (at === wMime) return w;
        if (at.endsWith('/*') && wMime.startsWith(at.slice(0, -1))) return w;
      }
    }
    return false;
  }

  acceptsLanguages(langs?: string | string[]): string | false {
    const acceptLang = this.headers['accept-language'] || '';
    if (!langs) return acceptLang || false;
    const wanted = Array.isArray(langs) ? langs : [langs];
    if (!acceptLang) return wanted[0] || false;
    const accepted = acceptLang
      .split(',')
      .map(s => {
        const parts = s.trim().split(';');
        const tag = (parts[0] ?? '').toLowerCase();
        const qPart = parts.find(p => p.trim().startsWith('q='));
        const q = qPart ? parseFloat(qPart.trim().slice(2)) : 1;
        return { tag, q: isNaN(q) ? 0 : q };
      })
      .filter(a => a.q > 0)
      .sort((a, b) => b.q - a.q);
    for (const { tag } of accepted) {
      for (const w of wanted) {
        const wl = w.toLowerCase();
        if (tag === '*' || tag === wl || tag.split('-')[0] === wl.split('-')[0]) return w;
      }
    }
    return false;
  }
}

/**
 * uWebSockets HTTP Server Adapter
 * Bridges uWebSockets.js with Moro's HTTP abstractions
 */
export class UWebSocketsHttpServer {
  private app: any; // uWebSockets app instance
  private uws: any; // uWebSockets module reference (stored to avoid re-importing)
  private _limits?: HttpRuntimeLimits;
  private multipartLimits?: MultipartLimits;
  private listenSocket: any; // uWebSockets listen socket
  private globalMiddleware: Middleware[] = [];
  private logger = createFrameworkLogger('UWSHttpServer');
  private hookManager: any;
  private requestCounter = 0;
  private requestTrackingEnabled = true; // Generate request IDs (read lazily by UwsRequest)
  private isListening = false;
  private port?: number;
  private host?: string;
  private initPromise: Promise<void>;
  /** @internal read by UwsRequest#protocol */
  isSsl = false;

  // Body size limits (bytes) - configured from server.bodySizeLimit/maxUploadSize
  private maxBodySize: number = 10 * 1024 * 1024;
  private maxUploadSize: number = 100 * 1024 * 1024;

  // Direct router dispatch (set from Moro.listen via setRouterHandler)
  private routerHandler?: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>;

  // Provider of fast-path routes to register on uWS's native router at listen()
  private nativeRouteProvider?: () => Array<{
    method: string;
    path: string;
    paramNames: string[] | null;
    handler: (req: HttpRequest, res: HttpResponse) => any;
  }>;

  // Shared error handling for native fast-path routes (unified router semantics)
  private nativeErrorHandler?: (req: HttpRequest, res: HttpResponse, err: any) => Promise<boolean>;

  // String interning for common values
  private static readonly INTERNED_METHODS = new Map([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['delete', 'DELETE'],
    ['patch', 'PATCH'],
    ['head', 'HEAD'],
    ['options', 'OPTIONS'],
  ]);

  // Pre-compiled response buffers
  private static readonly RESPONSE_BUFFERS = {
    notFound: Buffer.from('{"success":false,"error":"Not found"}'),
    serverError: Buffer.from('{"success":false,"error":"Internal server error"}'),
  };

  // Pre-cached status strings for common codes (performance optimization)
  private static readonly STATUS_STRINGS = new Map([
    [200, '200 OK'],
    [201, '201 Created'],
    [204, '204 No Content'],
    [301, '301 Moved Permanently'],
    [302, '302 Found'],
    [304, '304 Not Modified'],
    [400, '400 Bad Request'],
    [401, '401 Unauthorized'],
    [403, '403 Forbidden'],
    [404, '404 Not Found'],
    [500, '500 Internal Server Error'],
    [502, '502 Bad Gateway'],
    [503, '503 Service Unavailable'],
  ]);

  constructor(
    options: {
      ssl?: {
        key_file_name?: string;
        cert_file_name?: string;
        ca_file_name?: string;
        passphrase?: string;
      } | null;
      /** True when a TLS config was given but only as inline PEM (uWS needs
       *  file paths); triggers a clear error instead of a silent plain boot. */
      sslInlineOnly?: boolean;
      limits?: HttpRuntimeLimits;
      maxBodySize?: number;
      maxUploadSize?: number;
      /** Preloaded native engine module (from loadNativeEngine) - avoids a
       * second resolution and keeps load failures at the framework's
       * synchronous preflight instead of surfacing at listen() */
      engineModule?: any;
    } = {}
  ) {
    if (options.maxBodySize) this.maxBodySize = options.maxBodySize;
    if (options.maxUploadSize) this.maxUploadSize = options.maxUploadSize;
    if (options.limits) this._limits = options.limits;
    if (options.limits?.multipart) this.multipartLimits = options.limits.multipart;
    this.initPromise = this.initialize(options);
  }

  // Direct router dispatch - called after global middleware without the
  // per-middleware promise machinery (mirrors MoroHttpServer.setRouterHandler)
  setRouterHandler(fn: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>): void {
    this.routerHandler = fn;
  }

  // Fast-path routes get registered directly on uWS's native C++ router at
  // listen() - zero middleware machinery, lazy headers, no promise for sync
  // handlers. The provider is evaluated at listen time so file-based/late
  // routes are included.
  setNativeRouteProvider(
    provider: () => Array<{
      method: string;
      path: string;
      paramNames: string[] | null;
      handler: (req: HttpRequest, res: HttpResponse) => any;
    }>,
    onError?: (req: HttpRequest, res: HttpResponse, err: any) => Promise<boolean>
  ): void {
    this.nativeRouteProvider = provider;
    if (onError) this.nativeErrorHandler = onError;
  }

  private async initialize(options: {
    ssl?: {
      key_file_name?: string;
      cert_file_name?: string;
      ca_file_name?: string;
      passphrase?: string;
    } | null;
    sslInlineOnly?: boolean;
    limits?: HttpRuntimeLimits;
    engineModule?: any;
  }): Promise<void> {
    try {
      // The framework preloads the engine synchronously (loadNativeEngine) and
      // injects it; loading here directly covers standalone construction.
      // This server is uWS-shaped only: never probe @morojs/engine, whose
      // Moro-shaped module would pass a generic load but has no App().
      const uwsModule =
        options.engineModule ?? loadNativeEngine({ candidates: ['uWebSockets.js'] })?.module;
      if (!uwsModule) {
        throw new Error(
          'uWebSockets.js is not available: ' +
            (getNativeEngineLoadErrors().join('; ') || 'not installed')
        );
      }
      this.uws = uwsModule.default || uwsModule;

      // A TLS config that was given only as inline PEM cannot be honored by
      // uWS (it requires on-disk file paths). Surface it loudly rather than
      // silently booting plain HTTP (the historical footgun).
      if (options.sslInlineOnly) {
        this.logger.error(
          'uWebSockets.js requires TLS key/cert as FILE PATHS (keyFile/certFile ' +
            'or key_file_name/cert_file_name); inline PEM is not supported. ' +
            'Booting WITHOUT TLS - provide file paths or use engine: "moro"/"node".',
          'Init'
        );
      }

      if (options.ssl && options.ssl.key_file_name && options.ssl.cert_file_name) {
        this.app = this.uws.SSLApp({
          key_file_name: options.ssl.key_file_name,
          cert_file_name: options.ssl.cert_file_name,
          ...(options.ssl.ca_file_name && { ca_file_name: options.ssl.ca_file_name }),
          passphrase: options.ssl.passphrase,
        });
        this.isSsl = true;
        this.logger.info('uWebSockets SSL/TLS HTTP server created', 'Init');
      } else {
        this.app = this.uws.App();
        this.logger.info('uWebSockets HTTP server created', 'Init');
      }

      // uWS has no knobs for TCP timeouts/backlog/maxConnections/maxHeaderSize;
      // if the user set any, say so once at startup rather than silently
      // ignoring them (the "no arbitrary caps" contract cuts both ways).
      const ignored: string[] = [];
      const t = options.limits?.timeouts ?? {};
      if (t.request || t.idle || t.keepAlive || t.headers) ignored.push('timeouts');
      if (options.limits?.maxConnections) ignored.push('maxConnections');
      if (options.limits?.backlog) ignored.push('backlog');
      if (options.limits?.maxHeaderSize || options.limits?.maxHeaders)
        ignored.push('header limits');
      if (ignored.length) {
        this.logger.info(
          `uWebSockets.js does not support these server options; they are ignored: ${ignored.join(', ')}`,
          'Init'
        );
      }

      // Setup generic route handler for all HTTP methods and paths
      this.setupRouteHandlers();
    } catch (error) {
      // Log helpful error message with installation instructions
      this.logger.error(
        'Failed to load the native HTTP engine\n' +
          'Install it with:\n' +
          '  npm install @morojs/engine\n' +
          '(or the legacy engine: npm install --save-dev github:uNetworking/uWebSockets.js#v20.52.0)\n' +
          "Or set engine: 'node' in your server config to use the standard HTTP server.\n" +
          'Error: ' +
          (error instanceof Error ? error.message : String(error)),
        'Init'
      );
      throw error; // Re-throw so framework.ts can catch and fallback
    }
  }

  private setupRouteHandlers(): void {
    // Catchall fallback for everything that isn't a native fast-path route:
    // middleware chains, hooks, non-fast-path routes, 404s. Native
    // method-specific routes registered later take priority in uWS's router
    // (static > parameter > wildcard).
    this.app.any('/*', (res: any, req: any) => {
      void this.handleRequest(req, res);
    });
  }

  // Register fast-path routes (no middleware/auth/validation) directly on
  // uWS's native router. A sync GET handler completes with zero header copies,
  // zero promises and a single corked write. Each wrapper carries a cheap
  // dynamic guard: the moment global middleware or request hooks exist, it
  // falls back to the full pipeline so no feature is ever bypassed.
  private registerNativeFastPathRoutes(): void {
    const provider = this.nativeRouteProvider;
    if (!provider || !this.app) return;

    let count = 0;
    for (const route of provider()) {
      const methodFn = route.method.toLowerCase();
      if (typeof this.app[methodFn] !== 'function') continue;
      // Only plain paths - uWS shares the :param syntax; anything exotic
      // (wildcards etc.) stays on the catchall/unified-router path
      if (!/^[A-Za-z0-9/_\-.:]*$/.test(route.path) || route.path.indexOf('*') !== -1) continue;

      const handler = route.handler;
      const paramNames = route.paramNames;
      const methodInterned = route.method;
      const needsBody =
        methodInterned === 'POST' || methodInterned === 'PUT' || methodInterned === 'PATCH';

      this.app[methodFn](route.path, (res: any, req: any) => {
        // Dynamic feature guard - anything registered at runtime sends the
        // request through the full pipeline instead
        if (
          this.globalMiddleware.length !== 0 ||
          (this.hookManager &&
            (this.hookManager.hasHooks === undefined || this.hookManager.hasHooks('request')))
        ) {
          void this.handleRequest(req, res);
          return;
        }
        this.handleNativeRoute(req, res, handler, methodInterned, paramNames, needsBody);
      });
      count++;
    }

    if (count > 0) {
      this.logger.info(`${count} fast-path routes registered on native uWS router`, 'NativeRoutes');
    }
  }

  private handleNativeRoute(
    req: any,
    res: any,
    handler: (req: HttpRequest, res: HttpResponse) => any,
    method: string,
    paramNames: string[] | null,
    needsBody: boolean
  ): void {
    res.aborted = false;

    const httpReq = new UwsRequest(this, req, method, req.getUrl(), req.getQuery());
    if (paramNames) {
      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        const paramName = paramNames[i];
        if (paramName === undefined) continue;
        params[paramName] = req.getParameter(i);
      }
      httpReq.params = params;
    }
    const httpRes = new UWebSocketsHttpServer.ResponsePrototype().init(
      res,
      req,
      this.logger,
      this._compression
    ) as any as HttpResponse;
    (httpRes as any)._moroReq = httpReq;

    if (needsBody) {
      // Body routes always go async: snapshot headers, arm the abort hook,
      // read the body, then run the handler
      httpReq.materialize();
      res._abortArmed = true;
      res.onAborted(() => {
        res.aborted = true;
        const hook = res._abortHook;
        if (hook) hook();
        const moroRes = res._moroRes;
        if (moroRes) moroRes._handleAbort();
      });
      const contentLength = req.getHeader('content-length');
      const bodyPromise =
        contentLength && parseInt(contentLength) > 0
          ? this.readBody(res, httpReq as any as HttpRequest)
          : Promise.resolve();
      bodyPromise
        .then(() => {
          if (res.aborted) return;
          const result = handler(httpReq as any as HttpRequest, httpRes);
          if (result && typeof (result as any).then === 'function') {
            return (result as Promise<any>).then(r => {
              if (r !== undefined && !httpRes.headersSent) httpRes.json(r);
            });
          }
          if (result !== undefined && !httpRes.headersSent) httpRes.json(result);
          return;
        })
        .catch(err => this.handleNativeRouteError(err, httpReq, httpRes, res));
      return;
    }

    try {
      const result = handler(httpReq as any as HttpRequest, httpRes);

      if (result && typeof (result as any).then === 'function') {
        // Async handler: it is suspended at its first await - snapshot
        // uWS-backed data and arm abort tracking before returning to the loop
        httpReq.materialize();
        res._abortArmed = true;
        res.onAborted(() => {
          res.aborted = true;
          const hook = res._abortHook;
          if (hook) hook();
          const moroRes = res._moroRes;
          if (moroRes) moroRes._handleAbort();
        });
        (result as Promise<any>).then(
          r => {
            if (r !== undefined && !httpRes.headersSent && !res.aborted) httpRes.json(r);
          },
          err => this.handleNativeRouteError(err, httpReq, httpRes, res)
        );
      } else if (result !== undefined && !httpRes.headersSent) {
        // Fully synchronous: single corked write, no header copy, no promise
        httpRes.json(result);
      }

      // A synchronous handler that returned with the response still open
      // (e.g. SSE: writeHead + periodic write) is about to hand an unfinished
      // uWS response back to the event loop - uWS forbids that without an
      // abort handler, and without one client disconnects are never noticed.
      if (!(httpRes as any).finished && !res.aborted && !res._abortArmed) {
        res._abortArmed = true;
        httpReq.materialize();
        res.onAborted(() => {
          res.aborted = true;
          const hook = res._abortHook;
          if (hook) hook();
          const moroRes = res._moroRes;
          if (moroRes) moroRes._handleAbort();
        });
      }
    } catch (err) {
      this.handleNativeRouteError(err, httpReq, httpRes, res);
    }
  }

  private handleNativeRouteError(
    err: any,
    httpReq: UwsRequest,
    httpRes: HttpResponse,
    res: any
  ): void {
    if (err?.statusCode === 413 && !res.aborted && !httpRes.headersSent) {
      httpRes.statusCode = 413;
      httpRes.setHeader('Content-Type', 'application/json');
      httpRes.end('{"success":false,"error":"Request entity too large"}');
      return;
    }

    if (err?.statusCode === 400 && !res.aborted && !httpRes.headersSent) {
      httpRes.statusCode = 400;
      httpRes.setHeader('Content-Type', 'application/json');
      httpRes.end('{"success":false,"error":"Invalid request body"}');
      return;
    }

    const sendFallback = () => {
      if (!res.aborted && !httpRes.headersSent) {
        // Same shape as the unified router's fast-path error response
        (httpRes as any).status(500).json({ error: 'Internal server error' });
      }
    };

    const errorHandler = this.nativeErrorHandler;
    if (errorHandler) {
      errorHandler(httpReq as any as HttpRequest, httpRes, err).then(
        handled => {
          if (!handled) sendFallback();
        },
        () => sendFallback()
      );
    } else {
      this.logger.error(
        `Route handler error: ${err instanceof Error ? err.message : String(err)}`,
        'NativeRouteError'
      );
      sendFallback();
    }
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    this.requestCounter++;

    // Single abort hook for the whole request lifecycle. uWS requires
    // onAborted for any response finished after returning to the event loop;
    // readBody chains onto res._abortHook rather than replacing this handler.
    res.aborted = false;
    res.onAborted(() => {
      res.aborted = true;
      const hook = res._abortHook;
      if (hook) hook();
      // Fire 'close'/'aborted' on the moro wrappers (SSE/monitor cleanup)
      const moroRes = res._moroRes;
      if (moroRes) moroRes._handleAbort();
    });

    let httpReq: any;
    let httpRes: any;

    try {
      // Create Moro-compatible request/response objects
      httpReq = this.createMoroRequest(req, res);
      httpRes = this.createMoroResponse(req, res);
      httpRes._moroReq = httpReq;

      const method = httpReq.method;

      // Parse body only if there's actually a body (check content-length).
      // Check first char for early exit (all body methods start with 'P')
      if (
        method.charCodeAt(0) === 80 && // 'P' char code
        (method === 'POST' || method === 'PUT' || method === 'PATCH')
      ) {
        const contentLength = req.getHeader('content-length');
        if (contentLength && parseInt(contentLength) > 0) {
          // readBody awaits - snapshot uWS-backed data first
          httpReq.materialize();
          await this.readBody(res, httpReq);
          // A client that disconnects mid-upload resolves readBody with a
          // null/partial body; do not run hooks, middleware or the handler for
          // a dead request (matches the native fast-path guard at ~line 625 and
          // the Node backend, whose aborted stream rejects parseBody).
          if (res.aborted) return;
        }
      }

      // Execute hooks before request processing - skipped entirely when none registered
      const hookManager = this.hookManager;
      if (hookManager && (hookManager.hasHooks === undefined || hookManager.hasHooks('request'))) {
        httpReq.materialize();
        await hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // Execute global middleware chain
      if (this.globalMiddleware.length > 0) {
        httpReq.materialize();
        await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
        if (httpRes.headersSent) return;
      }

      // Unified router direct dispatch
      const routerHandler = this.routerHandler;
      if (routerHandler) {
        const handled = routerHandler(httpReq, httpRes);
        if (handled) {
          if (typeof (handled as any).then === 'function') {
            // Async route: the handler is suspended at its first await - snapshot
            // uWS-backed data now, while the native request is still valid
            httpReq.materialize();
            if (await handled) return;
          } else {
            return;
          }
        }
      }

      // No route matched
      if (!httpRes.headersSent && !res.aborted) {
        httpRes.statusCode = 404;
        httpRes.setHeader('Content-Type', 'application/json');
        httpRes.end('{"success":false,"error":"Not found"}');
      }
    } catch (error) {
      // Payload-too-large: respond 413 rather than a generic 500
      if ((error as any)?.statusCode === 413 && !res.aborted && httpRes && !httpRes.headersSent) {
        httpRes.statusCode = 413;
        httpRes.setHeader('Content-Type', 'application/json');
        httpRes.end('{"success":false,"error":"Request entity too large"}');
        return;
      }

      // Malformed body: a client error (400), not a server error (500)
      if ((error as any)?.statusCode === 400 && !res.aborted && httpRes && !httpRes.headersSent) {
        httpRes.statusCode = 400;
        httpRes.setHeader('Content-Type', 'application/json');
        httpRes.end('{"success":false,"error":"Invalid request body"}');
        return;
      }

      this.logger.error(
        `Request handling error: ${error instanceof Error ? error.message : String(error)}`,
        'RequestError'
      );

      // Send error response if not already sent
      if (!res.aborted) {
        try {
          res.cork(() => {
            res.writeStatus('500 Internal Server Error');
            res.writeHeader('Content-Type', 'application/json');
            res.end('{"success":false,"error":"Internal server error"}');
          });
        } catch {
          this.logger.error('Failed to send error response', 'ResponseError');
        }
      }
    }
  }

  private createMoroRequest(req: any, _res: any): HttpRequest {
    const url = req.getUrl();
    const queryString = req.getQuery();
    const methodRaw = req.getMethod();

    // Use interned method string if available
    const method = UWebSocketsHttpServer.INTERNED_METHODS.get(methodRaw) || methodRaw.toUpperCase();

    // Headers/query/cookies/requestId are lazy on the UwsRequest prototype -
    // materialize() snapshots them before the first await
    return new UwsRequest(this, req, method, url, queryString) as unknown as HttpRequest;
  }

  // Strip CR/LF from a header value to prevent response-splitting / header
  // injection, matching Node's setHeader ERR_INVALID_CHAR guarantee. Guarded
  // with indexOf so the common (clean) path allocates nothing on the hot path.
  private static sanitizeHeaderValue(value: string): string {
    return value.indexOf('\r') === -1 && value.indexOf('\n') === -1
      ? value
      : value.replace(/[\r\n]/g, '');
  }

  // Optimized helper to write headers
  private static writeHeaders(res: any, headers: Record<string, string | string[]>): void {
    // Performance: for...in is the fastest way to iterate response headers
    for (const key in headers) {
      const value = headers[key];
      if (Array.isArray(value)) {
        // Emit one header line per element instead of comma-joining. RFC 6265
        // forbids folding Set-Cookie, and browsers parse a folded
        // `a=1; Path=/, b=2` as a single cookie, silently dropping the second
        // (session + CSRF is the canonical breakage). uWS writes a separate
        // line per writeHeader call with the same key.
        for (let i = 0; i < value.length; i++) {
          res.writeHeader(key, UWebSocketsHttpServer.sanitizeHeaderValue(String(value[i])));
        }
        continue;
      }
      res.writeHeader(key, UWebSocketsHttpServer.sanitizeHeaderValue(String(value)));
    }
  }

  // Helper to get status string (cached for performance)
  private static getStatusString(code: number): string {
    return UWebSocketsHttpServer.STATUS_STRINGS.get(code) || `${code} OK`;
  }

  // Pre-define methods on prototype instead of creating new closures for each request
  private static readonly ResponsePrototype = class extends LazyEventEmitter {
    public headersSent = false;
    public statusCode = 200;
    public responseHeaders: Record<string, string | string[]> = {};
    private _res: any;
    private _req: any;
    private _logger: any;
    // Terminal-write latch: headersSent means "head flushed" (true mid-stream
    // after writeHead/write), _ended means the body is complete
    private _ended = false;
    private _drainArmed = false;
    // Accept-Encoding captured eagerly (uWS req is valid only synchronously)
    // and the server's compression settings, for buffered-response compression.
    private _acceptEncoding: string | undefined = undefined;
    private _compression: CompressionSettings | undefined = undefined;
    // The UwsRequest wrapper, linked by the server so lifecycle events reach
    // req.on('close') listeners (SSE cleanup, monitors)
    public _moroReq: any = null;

    init(res: any, req: any, logger: any, compression?: CompressionSettings) {
      this.headersSent = false;
      this.statusCode = 200;
      // Fresh object (a delete-loop reset would push the object into V8
      // dictionary mode, slowing every later header access)
      this.responseHeaders = {};
      this._res = res;
      this._req = req;
      this._logger = logger;
      this._ended = false;
      this._drainArmed = false;
      this._compression = compression;
      // Capture Accept-Encoding now: the native req is valid only during the
      // synchronous handler entry, but compression resolves asynchronously.
      this._acceptEncoding =
        compression?.enabled && req ? req.getHeader('accept-encoding') || undefined : undefined;
      // Route client aborts to the wrapper so 'close' fires (see onAborted)
      res._moroRes = this;
      return this;
    }

    // Buffered-response compression for uWS (parity with the engine/Node
    // paths). Returns true when it took over the write (async), false when the
    // caller should proceed with its normal synchronous cork+end.
    private _tryCompressedEnd(body: string | Buffer, contentType: string | undefined): boolean {
      const s = this._compression;
      if (!s || !s.enabled) return false;
      const bytes = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
      if (bytes < s.threshold) return false;
      if ('content-encoding' in this.responseHeaders) return false;
      if (this.statusCode === 204 || this.statusCode === 304) return false;
      const ctHeader = this.responseHeaders['content-type'];
      const ct = contentType ?? (Array.isArray(ctHeader) ? ctHeader[0] : (ctHeader as string));
      if (!isCompressible(ct)) return false;
      const encoding = negotiateEncoding(this._acceptEncoding, s.encodings);
      if (!encoding) return false;

      void compressBuffer(body, encoding, s.level)
        .then(compressed => {
          if (this._ended || this._res.aborted) return;
          this.responseHeaders['content-encoding'] = encoding;
          const vary = this.responseHeaders['vary'];
          this.responseHeaders['vary'] = vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding';
          this._res.cork(() => {
            this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
            UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
            this._res.end(compressed);
          });
          this.headersSent = true;
          this._ended = true;
          this._emitDone();
        })
        .catch((err: unknown) => {
          this._logger?.error?.(
            `uWS response compression failed: ${err instanceof Error ? err.message : String(err)}`,
            'Response'
          );
          if (this._ended || this._res.aborted) return;
          this._res.cork(() => {
            this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
            UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
            this._res.end(body);
          });
          this.headersSent = true;
          this._ended = true;
          this._emitDone();
        });
      return true;
    }

    get writableEnded() {
      return this._ended;
    }

    get writableFinished() {
      return this._ended;
    }

    get finished() {
      return this._ended;
    }

    // Node ServerResponse lifecycle: 'finish' then 'close' after the terminal
    // write; the request wrapper's 'close' fires too (IncomingMessage parity).
    // No listeners -> two null checks, nothing else.
    private _emitDone() {
      this._ended = true;
      if (this._events) {
        this.emit('finish');
        this.emit('close');
      }
      const req = this._moroReq;
      if (req && req._events) req.emit('close');
    }

    // Client aborted: 'close' without 'finish' (Node semantics), plus
    // 'aborted'/'close' on the request wrapper
    _handleAbort() {
      if (this._ended) return;
      this._ended = true;
      if (this._events) this.emit('close');
      const req = this._moroReq;
      if (req && req._events) {
        req.emit('aborted');
        req.emit('close');
      }
    }

    // Backpressure: surface uWS's onWritable as the 'drain' event pipe()
    // and manual streaming loops wait on
    private _armDrain() {
      if (this._drainArmed) return;
      this._drainArmed = true;
      try {
        this._res.onWritable(() => {
          this._drainArmed = false;
          this.emit('drain');
          return true;
        });
      } catch {
        this._drainArmed = false;
      }
    }

    status(code: number) {
      this.statusCode = code;
      return this;
    }

    setHeader(name: string, value: string | string[]) {
      // Cache toLowerCase result to avoid repeated calls
      const lowerName = name.toLowerCase();
      this.responseHeaders[lowerName] = value;
      return this;
    }

    getHeader(name: string) {
      // Cache toLowerCase result
      const lowerName = name.toLowerCase();
      return this.responseHeaders[lowerName];
    }

    removeHeader(name: string) {
      const lowerName = name.toLowerCase();
      if (lowerName in this.responseHeaders) {
        delete this.responseHeaders[lowerName];
      }
      return this;
    }

    json(data: any) {
      if (this.headersSent || this._res.aborted) return;

      // Fast-path JSON serialization for common API patterns
      let body: string;

      // The interpolated fast path is only valid when `success` is a real
      // boolean (a string/number would produce invalid JSON like
      // {"success":yes,...}), and each interpolated field must be defined
      // (JSON.stringify(undefined) yields the literal token "undefined", which
      // would corrupt the body). Otherwise fall through to JSON.stringify.
      if (data && typeof data === 'object' && typeof data.success === 'boolean') {
        let keyCount = 0;
        let hasData = false;
        let hasError = false;
        let hasTotal = false;

        for (const key in data) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            keyCount++;
            if (key === 'data') hasData = true;
            else if (key === 'error') hasError = true;
            else if (key === 'total') hasTotal = true;
          }
        }

        if (
          keyCount === 3 &&
          hasData &&
          hasError &&
          data.data !== undefined &&
          data.error !== undefined
        ) {
          body = `{"success":${data.success},"data":${JSON.stringify(data.data)},"error":${JSON.stringify(data.error)}}`;
        } else if (
          keyCount === 3 &&
          hasData &&
          hasTotal &&
          data.data !== undefined &&
          typeof data.total === 'number'
        ) {
          body = `{"success":${data.success},"data":${JSON.stringify(data.data)},"total":${data.total}}`;
        } else if (keyCount === 2 && hasData && data.data !== undefined) {
          body = `{"success":${data.success},"data":${JSON.stringify(data.data)}}`;
        } else if (keyCount === 2 && hasError && data.error !== undefined) {
          body = `{"success":${data.success},"error":${JSON.stringify(data.error)}}`;
        } else {
          body = JSON.stringify(data);
        }
      } else {
        body = JSON.stringify(data);
      }

      if (!('content-type' in this.responseHeaders)) {
        this.responseHeaders['content-type'] = 'application/json';
      }

      try {
        // Compression (when enabled + compressible + accepted) takes over the
        // write asynchronously; otherwise the synchronous corked path runs.
        if (this._tryCompressedEnd(body, 'application/json')) return;
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end(body);
        });
        this.headersSent = true;
        this._emitDone();
      } catch {
        this._logger.error('Failed to send JSON response', 'ResponseError');
      }
    }

    send(data: string | Buffer) {
      if (this.headersSent || this._res.aborted) return;

      const body = typeof data === 'string' ? data : data.toString();

      try {
        if (this._tryCompressedEnd(body, undefined)) return;
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end(body);
        });
        this.headersSent = true;
        this._emitDone();
      } catch {
        this._logger.error('Failed to send response', 'ResponseError');
      }
    }

    // Flush status + headers without ending the response (Node streaming
    // entry point - SSE and manual chunked responses start here). Supports
    // both (code, headers) and (code, statusMessage, headers) signatures;
    // uWS derives the reason phrase from the status string, so a custom
    // message is folded into it.
    writeHead(statusCode: number, reasonOrHeaders?: any, maybeHeaders?: any) {
      if (this.headersSent || this._res.aborted) return this;

      this.statusCode = statusCode;
      const headers =
        reasonOrHeaders && typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      if (headers) {
        for (const key of Object.keys(headers)) {
          this.setHeader(key, headers[key]);
        }
      }

      try {
        this._res.cork(() => {
          const status =
            typeof reasonOrHeaders === 'string'
              ? `${statusCode} ${reasonOrHeaders}`
              : UWebSocketsHttpServer.getStatusString(statusCode);
          this._res.writeStatus(status);
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
        });
        this.headersSent = true;
      } catch {
        this._logger.error('Failed to write response head', 'ResponseError');
      }

      return this;
    }

    // Stream a body chunk, flushing the head first if needed. Returns uWS's
    // backpressure signal like Node's Writable.write; 'drain' fires when the
    // socket can accept more.
    write(chunk: any, encoding?: any, callback?: any): boolean {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (this._ended || this._res.aborted) return false;

      let ok = true;
      try {
        this._res.cork(() => {
          if (!this.headersSent) {
            this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
            UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
            this.headersSent = true;
          }
          ok = this._res.write(chunk);
        });
      } catch {
        this._logger.error('Failed to write response chunk', 'ResponseError');
        return false;
      }

      if (!ok) this._armDrain();
      if (typeof callback === 'function') callback();
      return ok;
    }

    end(data?: any, encoding?: any, callback?: any) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      // Guard on _ended, not headersSent: in streaming mode (writeHead/write)
      // the head is already flushed and end() must still complete the body
      if (this._ended || this._res.aborted) {
        if (typeof callback === 'function') callback();
        return this;
      }

      try {
        this._res.cork(() => {
          if (!this.headersSent) {
            this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
            UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
            this.headersSent = true;
          }
          this._res.end(data || '');
        });
        this._emitDone();
        if (typeof callback === 'function') callback();
      } catch {
        this._logger.error('Failed to end response', 'ResponseError');
        if (typeof callback === 'function') callback();
      }

      return this;
    }

    redirect(url: string, code?: number) {
      if (this.headersSent || this._res.aborted) return;

      const redirectCode = code || 302;
      this.statusCode = redirectCode;

      try {
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(redirectCode));
          this._res.writeHeader('Location', UWebSocketsHttpServer.sanitizeHeaderValue(url));
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end();
        });
        this.headersSent = true;
        this._emitDone();
      } catch {
        this._logger.error('Failed to send redirect', 'ResponseError');
      }
    }

    // Standardized response helpers
    success<T = any>(data: T, message?: string) {
      const response: any = {
        success: true,
        data,
      };
      if (message !== undefined) {
        response.message = message;
      }
      this.json(response);
    }

    error(error: string, code?: string, message?: string) {
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
      this.json(response);
    }

    // Common HTTP error helpers (automatically set status code)
    unauthorized(message: string = 'Authentication required') {
      this.statusCode = 401;
      this.json({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message,
      });
    }

    forbidden(message: string = 'Insufficient permissions') {
      this.statusCode = 403;
      this.json({
        success: false,
        error: 'Forbidden',
        code: 'FORBIDDEN',
        message,
      });
    }

    notFound(resource: string = 'Resource') {
      this.statusCode = 404;
      this.json({
        success: false,
        error: 'Not Found',
        code: 'NOT_FOUND',
        message: `${resource} not found`,
      });
    }

    badRequest(message: string = 'Invalid request') {
      this.statusCode = 400;
      this.json({
        success: false,
        error: 'Bad Request',
        code: 'BAD_REQUEST',
        message,
      });
    }

    conflict(message: string) {
      this.statusCode = 409;
      this.json({
        success: false,
        error: 'Conflict',
        code: 'CONFLICT',
        message,
      });
    }

    internalError(message: string = 'Internal server error') {
      this.statusCode = 500;
      this.json({
        success: false,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message,
      });
    }

    validationError(errors: Array<{ field: string; message: string; code?: string }>) {
      this.statusCode = 422;
      this.json({
        success: false,
        error: 'Validation Failed',
        code: 'VALIDATION_ERROR',
        errors,
      });
    }

    rateLimited(retryAfter?: number) {
      this.statusCode = 429;
      if (retryAfter) {
        this.setHeader('Retry-After', retryAfter.toString());
      }
      this.json({
        success: false,
        error: 'Rate Limit Exceeded',
        code: 'RATE_LIMITED',
        message: retryAfter
          ? `Too many requests. Retry after ${retryAfter} seconds.`
          : 'Too many requests',
        retryAfter,
      });
    }

    // Common success patterns
    created<T = any>(data: T, location?: string) {
      this.statusCode = 201;
      if (location) {
        this.setHeader('Location', location);
      }
      this.json({
        success: true,
        data,
      });
    }

    noContent() {
      this.statusCode = 204;
      this.end();
    }

    paginated<T = any>(data: T[], pagination: { page: number; limit: number; total: number }) {
      const totalPages = Math.ceil(pagination.total / pagination.limit);
      this.json({
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
    }

    cookie(name: string, value: string, options?: any) {
      // Percent-encode the value (matches the Node path and Express) so a value
      // containing ';'/',' can't inject cookie attributes and control chars
      // don't corrupt the Set-Cookie header.
      const parts = [name, '=', encodeURIComponent(value)];

      if (options) {
        // maxAge: 0 is meaningful (immediate expiry - clearCookie relies on it)
        if (options.maxAge !== undefined && options.maxAge !== null) {
          parts.push('; Max-Age=', String(options.maxAge));
        }
        if (options.expires) {
          const expires =
            options.expires instanceof Date
              ? options.expires.toUTCString()
              : String(options.expires);
          parts.push('; Expires=', expires);
        }
        if (options.domain) {
          parts.push('; Domain=', options.domain);
        }
        if (options.secure) {
          parts.push('; Secure');
        }
        if (options.httpOnly) {
          parts.push('; HttpOnly');
        }
        if (options.sameSite) {
          parts.push('; SameSite=', options.sameSite);
        }
      }
      // Path defaults to '/' (Express behavior) so clearCookie() from a nested
      // route can clear a cookie originally set at the site root.
      parts.push('; Path=', options?.path ?? '/');

      const cookie = parts.join('');
      const lowerKey = 'set-cookie';
      const existing = this.responseHeaders[lowerKey];
      if (existing) {
        if (Array.isArray(existing)) {
          existing.push(cookie);
        } else {
          this.responseHeaders[lowerKey] = [existing as string, cookie];
        }
      } else {
        this.responseHeaders[lowerKey] = cookie;
      }

      return this;
    }

    clearCookie(name: string, options: any = {}) {
      const clearOptions: any = { expires: new Date(0), maxAge: 0 };
      if (options.path !== undefined) clearOptions.path = options.path;
      if (options.domain !== undefined) clearOptions.domain = options.domain;
      if (options.httpOnly !== undefined) clearOptions.httpOnly = options.httpOnly;
      if (options.secure !== undefined) clearOptions.secure = options.secure;
      if (options.sameSite !== undefined) clearOptions.sameSite = options.sameSite;
      return this.cookie(name, '', clearOptions);
    }

    // ==== Express-compatible response helpers (parity with the Node adapter) ====

    public locals: Record<string, any> = {};

    set(field: string | Record<string, any>, value?: any) {
      if (this.headersSent) return this;
      if (typeof field === 'string') {
        if (value !== undefined) this.setHeader(field, value);
      } else {
        for (const key in field) {
          this.setHeader(key, field[key]);
        }
      }
      return this;
    }

    get(field: string) {
      return this.getHeader(field);
    }

    hasHeader(name: string): boolean {
      return this.getHeader(name) !== undefined;
    }

    setBulkHeaders(headers: Record<string, string | number>) {
      if (this.headersSent) return this;
      for (const key in headers) {
        this.setHeader(key, String(headers[key]));
      }
      return this;
    }

    appendHeader(name: string, value: string | string[]) {
      if (this.headersSent) return this;
      const lower = name.toLowerCase();
      const existing = this.responseHeaders[lower];
      if (existing) {
        const values = Array.isArray(existing) ? existing : [existing as string];
        const incoming = Array.isArray(value) ? value : [value];
        this.responseHeaders[lower] = values.concat(incoming);
      } else {
        this.responseHeaders[lower] = value;
      }
      return this;
    }

    append(field: string, value: string | string[]) {
      return this.appendHeader(field, value);
    }

    type(contentType: string) {
      if (this.headersSent) return this;
      let ct = contentType;
      if (ct.indexOf('/') === -1) {
        const shorthands: Record<string, string> = {
          json: 'application/json; charset=utf-8',
          html: 'text/html; charset=utf-8',
          text: 'text/plain; charset=utf-8',
          txt: 'text/plain; charset=utf-8',
          xml: 'application/xml',
          js: 'application/javascript',
          css: 'text/css; charset=utf-8',
          form: 'application/x-www-form-urlencoded',
        };
        ct = shorthands[ct.toLowerCase()] || `application/${ct}`;
      }
      this.setHeader('Content-Type', ct);
      return this;
    }

    sendStatus(code: number) {
      if (this.headersSent) return;
      this.statusCode = code;
      const statusString = UWebSocketsHttpServer.getStatusString(code);
      const body = statusString.slice(String(code).length + 1) || String(code);
      this.setHeader('Content-Type', 'text/plain; charset=utf-8');
      this.end(body);
    }

    location(url: string) {
      if (this.headersSent) return this;
      this.setHeader('Location', url.replace(/[\r\n]/g, ''));
      return this;
    }

    vary(field: string | string[]) {
      if (this.headersSent) return this;
      const existing = this.responseHeaders['vary'];
      const existingList = existing
        ? String(existing)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [];
      const incoming = Array.isArray(field) ? field : [field];
      for (const f of incoming) {
        if (!existingList.some(e => e.toLowerCase() === f.toLowerCase())) {
          existingList.push(f);
        }
      }
      this.responseHeaders['vary'] = existingList.join(', ');
      return this;
    }

    links(links: Record<string, string>) {
      if (this.headersSent) return this;
      const parts: string[] = [];
      for (const rel in links) {
        parts.push(`<${links[rel]}>; rel="${rel}"`);
      }
      if (parts.length > 0) {
        const existing = this.responseHeaders['link'];
        this.responseHeaders['link'] = existing
          ? `${existing}, ${parts.join(', ')}`
          : parts.join(', ');
      }
      return this;
    }

    canSetHeaders(): boolean {
      return !this.headersSent;
    }

    getResponseState() {
      return {
        headersSent: this.headersSent,
        statusCode: this.statusCode,
        headers: this.responseHeaders,
        finished: this._ended,
        writable: !this._ended,
      };
    }
  };

  private createMoroResponse(req: any, res: any): HttpResponse {
    // Fresh instance per request. Pooling these was a correctness hazard: a
    // handler that responds after returning (timers, streams) would write into
    // a recycled object already serving another request.
    const httpRes = new UWebSocketsHttpServer.ResponsePrototype();
    httpRes.init(res, req, this.logger);
    return httpRes as any as HttpResponse;
  }

  private async readBody(res: any, httpReq: HttpRequest): Promise<void> {
    const contentType = httpReq.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');
    const maxSize = isMultipart ? this.maxUploadSize : this.maxBodySize;

    return new Promise((resolve, reject) => {
      // Collect chunks in array, concat once at end (faster than repeated Buffer.concat)
      const chunks: Buffer[] = [];
      let totalLength = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        res._abortHook = null;
        fn();
      };

      res.onData((chunk: ArrayBuffer, isLast: boolean) => {
        if (settled) return;

        // Buffer.from(ArrayBuffer) is a zero-copy VIEW of uWS-owned memory,
        // which uWS recycles after this callback returns. The final chunk is
        // consumed synchronously below, so the view is safe; earlier chunks
        // must be copied or they alias reused memory (silent body corruption).
        const view = Buffer.from(chunk);
        totalLength += view.length;

        if (totalLength > maxSize) {
          const error: any = new Error(
            isMultipart ? 'File upload too large' : 'Request body too large'
          );
          error.statusCode = 413;
          finish(() => reject(error));
          return;
        }

        if (!isLast) {
          const copy = Buffer.allocUnsafe(view.length);
          view.copy(copy);
          chunks.push(copy);
          return;
        }

        // Final chunk: single-chunk bodies (the common case) parse straight
        // from the view with zero copies
        let buffer: Buffer;
        if (chunks.length === 0) {
          buffer = view;
        } else {
          chunks.push(view);
          buffer = Buffer.concat(chunks, totalLength);
        }

        try {
          if (contentType.includes('application/json')) {
            httpReq.body = totalLength === 0 ? null : JSON.parse(buffer.toString('utf-8'));
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(buffer.toString('utf-8'));
            const body: Record<string, any> = {};
            params.forEach((value, key) => {
              body[key] = value;
            });
            httpReq.body = body;
          } else if (isMultipart) {
            // Shared parser (same as the Node http server) - stringifying
            // multipart would corrupt binary uploads and lose fields/files.
            // parseMultipart retains slices of the payload as file Buffers;
            // the single-chunk fast path (buffer === view) aliases uWS-owned
            // memory that is recycled after this callback returns, so copy
            // it first. Concatenated multi-chunk buffers are already stable.
            const stable = buffer === view ? Buffer.from(buffer) : buffer;
            httpReq.body = parseMultipartBuffer(stable, contentType, this.multipartLimits);
          } else {
            httpReq.body = buffer.toString('utf-8');
          }

          finish(resolve);
        } catch (parseError) {
          // A limit error (multipart maxParts/maxFiles/maxFileSize) carries its
          // own 413 - preserve it rather than masking it as a generic 400.
          if (parseError && typeof (parseError as any).statusCode === 'number') {
            finish(() => reject(parseError));
            return;
          }
          // A malformed body is a client error: reject with 400 (parity with
          // the engine and Node transports) rather than silently handing the
          // handler a null body it may treat as "no input".
          const error: any = new Error(
            `Invalid request body: ${parseError instanceof Error ? parseError.message : String(parseError)}`
          );
          error.statusCode = 400;
          finish(() => reject(error));
        }
      });

      // Chain onto the request-lifetime abort hook (registered in handleRequest
      // or the native route wrapper) instead of replacing it
      res._abortHook = () => {
        this.logger.debug('Request aborted', 'RequestAborted');
        finish(resolve);
      };

      // If the client already disconnected before we attached the hook
      if (res.aborted) {
        finish(resolve);
      }
    });
  }

  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    for (const mw of middleware) {
      if (res.headersSent) break;

      await new Promise<void>((resolve, reject) => {
        try {
          const result = mw(req, res, (err?: Error) => {
            if (err) reject(err);
            else resolve();
          });

          // Handle async middleware
          if (result && typeof result.then === 'function') {
            result.then(() => resolve()).catch(reject);
          }
        } catch (error) {
          reject(error);
        }
      });
    }
  }

  // Public API - matches MoroHttpServer interface

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

  // Configure request tracking (ID generation)
  setRequestTracking(enabled: boolean): void {
    this.requestTrackingEnabled = enabled;
  }

  // Note: Route registration methods (get, post, etc.) are not used by uWebSockets adapter
  // All routing is handled by UnifiedRouter through the middleware chain

  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  /** @internal buffered-response compression settings (read at init). */
  _compression: CompressionSettings = resolveCompressionSettings();

  configurePerformance(config: any): void {
    // uWS batches the request hot path natively; response compression is the
    // one thing it doesn't do itself, so wire that here (parity with Node/
    // engine). Buffered responses only - streaming stays raw.
    this._compression = resolveCompressionSettings(config);
    this.logger.debug(
      `Performance configured (compression ${this._compression.enabled ? 'on' : 'off'})`,
      'Config'
    );
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void): void {
    // Wrap in async to await init
    this.initPromise
      .then(() => {
        if (this.isListening) {
          this.logger.warn('Server is already listening', 'Listen');
          return;
        }

        const host = typeof hostOrCallback === 'string' ? hostOrCallback : '0.0.0.0';
        const cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;

        this.port = port;
        this.host = host;

        // Register fast-path routes on the native router now that all routes
        // (including file-based/auto-discovered ones) are loaded
        try {
          this.registerNativeFastPathRoutes();
        } catch (error) {
          this.logger.warn(
            `Native fast-path route registration failed, falling back to catchall: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'NativeRoutes'
          );
        }

        // Check if we're in a cluster environment
        const isClusterWorker = cluster.isWorker;

        // uWebSockets.js automatically enables SO_REUSEPORT when in cluster mode
        // Do NOT pass listenOptions in cluster mode - let uWS handle it automatically
        // In non-cluster mode, we don't need SO_REUSEPORT

        const onListen = (token: any) => {
          if (token) {
            this.listenSocket = token;
            this.isListening = true;
            const clusterInfo = isClusterWorker ? ` (worker ${process.pid})` : '';
            this.logger.info(
              `uWebSockets HTTP server listening on ${host}:${port}${clusterInfo}`,
              'Listen'
            );
            if (cb) cb();
          } else {
            const clusterInfo = isClusterWorker ? ` (worker ${process.pid})` : '';
            this.logger.error(`Failed to listen on ${host}:${port}${clusterInfo}`, 'Listen');
            // Don't throw in cluster workers - let them fail gracefully
            if (!isClusterWorker) {
              throw new Error(`Failed to bind to ${host}:${port}`);
            }
          }
        };

        // Honor the requested bind host. For the all-interfaces default (and
        // cluster mode, where uWS auto-enables SO_REUSEPORT) keep the 2-arg
        // form so that behavior is unchanged; when a specific host is given
        // (e.g. 127.0.0.1 for an internal/admin service behind a proxy) use
        // uWS's (host, port, cb) overload so we don't silently bind 0.0.0.0.
        const bindAllInterfaces = host === '0.0.0.0' || host === '::';
        if (bindAllInterfaces) {
          this.app.listen(port, onListen);
        } else {
          this.app.listen(host, port, onListen);
        }
      })
      .catch(error => {
        this.logger.error('Failed to initialize server before listen', 'Listen', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  close(callback?: (error?: Error) => void): void {
    if (!this.isListening) {
      if (callback) callback();
      return;
    }

    try {
      // Close the listen socket first
      if (this.listenSocket && this.uws) {
        this.uws.us_listen_socket_close(this.listenSocket);
        this.listenSocket = null;
        this.isListening = false;
        this.logger.info('uWebSockets listen socket closed', 'Close');
      }

      // Clear middleware to break references
      this.globalMiddleware = [];

      // Clear the app reference to release uWebSockets resources
      // This is critical for worker thread cleanup
      if (this.app) {
        // Remove any route handlers
        this.app = null;
      }

      if (callback) {
        // Give the event loop time to process any pending uWebSockets events
        // before invoking the callback. This ensures handles are properly closed.
        setTimeout(() => {
          callback();
        }, 50);
      }
    } catch (error) {
      this.logger.error('Error closing server', 'Close', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (callback) callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getServer(): any {
    // Return the uWebSockets app for direct access if needed
    return this.app;
  }

  getApp(): any {
    return this.app;
  }

  // Get app descriptor for worker thread clustering
  getDescriptor(): any {
    if (!this.app || typeof this.app.getDescriptor !== 'function') {
      throw new Error('uWebSockets app does not support getDescriptor()');
    }
    return this.app.getDescriptor();
  }

  // Add child app descriptor for acceptor pattern
  addChildAppDescriptor(descriptor: any): void {
    if (!this.app || typeof this.app.addChildAppDescriptor !== 'function') {
      throw new Error('uWebSockets app does not support addChildAppDescriptor()');
    }
    this.app.addChildAppDescriptor(descriptor);
  }

  forceCleanup(): void {
    // Cleanup method for compatibility
    this.logger.debug('Force cleanup called', 'Cleanup');
  }
}
