// Moro Engine HTTP Server Implementation (@morojs/engine)
//
// One of the three HTTP backends, kept deliberately separate from the others:
//   - MoroHttpServer        (http-server.ts)      -> Node's http module
//   - UWebSocketsHttpServer (uws-http-server.ts)  -> uWebSockets.js (opt-in)
//   - MoroEngineServer      (this file)           -> @morojs/engine, Moro's own
//                                                    from-scratch native engine
//
// Bridges the Moro-shaped native engine API (one JS crossing per request in,
// one out - see the engine repo's docs/API.md) with Moro's HTTP abstractions.
// Unlike the uWS adapter there is no materialize() hazard: every per-request
// fetcher (getHeaders/getQuery/getBody/...) returns a stable snapshot, and the
// body is already complete when onRequest fires. Keep-alive, Content-Length,
// Date, chunked encoding, HEAD body suppression and native 413/400 are all
// engine concerns - this adapter never sees them. No dependency on the uWS
// adapter: shared helpers live in ./utils.

import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../logger/index.js';
import { HttpRequest, HttpResponse, HttpHandler, Middleware } from '../../types/http.js';
import {
  loadNativeEngine,
  getNativeEngineLoadErrors,
  type EngineCapabilities,
} from '../utilities/package-utils.js';
import {
  parseMultipart as parseMultipartBuffer,
  type MultipartLimits,
} from './utils/multipart-parser.js';
import type { HttpRuntimeLimits } from './utils/size.js';
import type { Http2ServerOptions } from './http2-server.js';
import {
  resolveCompressionSettings,
  compressBuffer,
  isCompressible,
  negotiateEncoding,
  type CompressionSettings,
} from './utils/compression.js';
import { LazyEventEmitter } from './utils/lazy-event-emitter.js';
import { parseRawQueryString as parseUwsQueryString } from './utils/query-parser.js';
import { PathMatcher } from '../routing/path-matcher.js';

/** Engine method table - onRequest's methodIdx indexes into this */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'OTHER'] as const;

// Pre-cached status strings for common codes (sendStatus bodies; the engine
// derives the wire reason phrase from the numeric status itself)
const STATUS_STRINGS = new Map([
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

// Same table as MoroHttpServer.getMimeType - kept sync here so attachment()
// stays chainable without a fire-and-forget promise
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

function mimeTypeFor(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

function addCharsetIfNeeded(mimeType: string): string {
  if (
    mimeType.startsWith('text/') ||
    mimeType.startsWith('application/json') ||
    mimeType.startsWith('application/javascript') ||
    mimeType.startsWith('application/xml') ||
    mimeType.startsWith('image/svg+xml')
  ) {
    if (!mimeType.includes('charset')) {
      return `${mimeType}; charset=utf-8`;
    }
  }
  return mimeType;
}

// Files up to this size are sent with a single respond(); larger ones stream
// through writeHead/write/end with backpressure respected via 'drain'
const SENDFILE_BUFFER_LIMIT = 1024 * 1024;

/**
 * Prototype-based request object for the engine adapter.
 *
 * Headers/query/cookies/ip/requestId are lazy: a synchronous handler that
 * never reads them pays nothing (no native crossing, no UUID). Every fetcher
 * returns a stable snapshot and reqIds are safe no-ops after the response
 * terminates, so - unlike the uWS adapter - there is no validity window.
 */
export class EngineRequest extends LazyEventEmitter {
  method: string;
  path: string;
  params: Record<string, string> = {};
  body: any = null;

  _server: MoroEngineServer;
  _reqId: number;
  _url: string | undefined = undefined;
  _queryString: string | undefined = undefined;
  _query: Record<string, string> | undefined = undefined;
  _headers: Record<string, string> | undefined = undefined;
  _cookies: Record<string, string> | undefined = undefined;
  _context: Record<string, any> | undefined = undefined;
  _requestId: string | undefined = undefined;
  _ip: string | undefined = undefined;
  _socket: any = undefined;

  constructor(server: MoroEngineServer, reqId: number, method: string, path: string) {
    super();
    this._server = server;
    this._reqId = reqId;
    this.method = method;
    this.path = path;
  }

  /** Engine snapshots are stable - nothing to detach. No-op kept for
   *  interface parity with UwsRequest so shared dispatch code can call it. */
  materialize(): void {}

  private _rawQueryString(): string {
    let qs = this._queryString;
    if (qs === undefined) {
      // Safe no-op (undefined) after the response terminates - coerce to ''
      qs = this._server._engine.getQuery(this._reqId) ?? '';
      this._queryString = qs as string;
    }
    return qs as string;
  }

  get url(): string {
    let u = this._url;
    if (u === undefined) {
      const qs = this._rawQueryString();
      u = qs ? `${this.path}?${qs}` : this.path;
      this._url = u;
    }
    return u;
  }
  set url(value: string) {
    this._url = value;
  }

  get query(): Record<string, string> {
    let q = this._query;
    if (q === undefined) {
      const qs = this._rawQueryString();
      q = qs ? parseUwsQueryString(qs) : {};
      this._query = q;
    }
    return q;
  }
  set query(value: Record<string, string>) {
    this._query = value;
  }

  get headers(): Record<string, string> {
    let h = this._headers;
    if (h === undefined) {
      h = {};
      // One crossing: flat [k1,v1,k2,v2,...] with keys already lowercased.
      // Duplicate header lines are joined like Node's IncomingMessage ('; '
      // for cookie, ', ' otherwise) - last-wins would let a client hide
      // earlier X-Forwarded-For entries from IP-based middleware.
      const flat: string[] | undefined = this._server._engine.getHeaders(this._reqId);
      if (flat) {
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const key = flat[i];
          const val = flat[i + 1];
          if (key === undefined || val === undefined) continue;
          const existing = h[key];
          if (existing === undefined) {
            h[key] = val;
          } else {
            h[key] = existing + (key === 'cookie' ? '; ' : ', ') + val;
          }
        }
      }
      this._headers = h;
    }
    return h;
  }
  set headers(value: Record<string, string>) {
    this._headers = value;
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

  get ip(): string {
    let ip = this._ip;
    if (ip === undefined) {
      ip = this._server._engine.getRemoteAddress(this._reqId) ?? '';
      this._ip = ip as string;
    }
    return ip as string;
  }
  set ip(value: string) {
    this._ip = value;
  }

  // Minimal net.Socket-shaped shim. `encrypted` reflects whether the engine
  // is terminating TLS for this server (engine >= 1.2.0); when it isn't and
  // TLS is proxy-terminated, middleware should read `x-forwarded-proto`. This
  // exists so code written against Node's IncomingMessage (req.socket.encrypted,
  // the CSRF middleware; req.connection.remoteAddress, rate-limiters) doesn't
  // throw on the engine transport. `connection` is the legacy alias for `socket`.
  get socket(): any {
    let s = this._socket;
    if (s === undefined) {
      const getIp = () => this.ip; // arrow captures this lexically (no this-alias)
      const encrypted = Boolean((this._server as any)?.isSsl);
      s = {
        get remoteAddress() {
          return getIp() || undefined;
        },
        remotePort: undefined,
        encrypted,
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

  // ==== Express-compatible request helpers (parity with the uWS adapter) ====

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
    return this.url;
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
 * Prototype-based response object for the engine adapter. Same
 * MoroResponseMethods surface as the uWS adapter's ResponsePrototype.
 *
 * Terminal writes (json/send/end/redirect) go out as ONE respond() call -
 * status + headers + body in a single native crossing. Streaming responses
 * (writeHead/write/end) map to the engine's streaming API; the engine's
 * onWritable backpressure signal surfaces as the 'drain' event.
 */
export class EngineResponse extends LazyEventEmitter {
  public headersSent = false;
  public statusCode = 200;
  public responseHeaders: Record<string, string | string[]> = {};
  public locals: Record<string, any> = {};
  // The EngineRequest wrapper, linked by the server so lifecycle events reach
  // req.on('close') listeners (SSE cleanup, monitors)
  public _moroReq: any = null;

  private _server: MoroEngineServer;
  private _engine: any;
  private _reqId: number;
  private _logger: any;
  // Terminal-write latch: headersSent means "head flushed" (true mid-stream
  // after writeHead/write), _ended means the body is complete
  private _ended = false;
  private _aborted = false;

  constructor(server: MoroEngineServer, reqId: number, logger: any) {
    super();
    this._server = server;
    this._engine = server._engine;
    this._reqId = reqId;
    this._logger = logger;
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

  get aborted() {
    return this._aborted;
  }

  // Node ServerResponse lifecycle: 'finish' then 'close' after the terminal
  // write; the request wrapper's 'close' fires too (IncomingMessage parity).
  // Also releases the reqId from the server's in-flight map.
  private _emitDone() {
    this._ended = true;
    this._server._complete(this._reqId);
    if (this._events) {
      this.emit('finish');
      this.emit('close');
    }
    const req = this._moroReq;
    if (req && req._events) req.emit('close');
  }

  // Client aborted: 'close' without 'finish' (Node semantics), plus
  // 'aborted'/'close' on the request wrapper. All later engine calls with
  // this reqId are safe no-ops, but the guards below skip them anyway.
  _handleAbort() {
    if (this._ended) return;
    this._ended = true;
    this._aborted = true;
    if (this._events) this.emit('close');
    const req = this._moroReq;
    if (req && req._events) {
      req.emit('aborted');
      req.emit('close');
    }
  }

  // Backpressure: the engine's onWritable relayed as the 'drain' event that
  // pipe() and manual streaming loops wait on
  _handleWritable() {
    this.emit('drain');
  }

  // Build the engine's flat [k1,v1,k2,v2,...] header array from headers
  // actually set. Multi-value headers (set-cookie) become separate pairs so
  // each goes out as its own header line.
  private _headersFlat(): string[] | null {
    const headers = this.responseHeaders;
    let flat: string[] | null = null;
    // Performance: for...in is the fastest way to iterate response headers
    for (const key in headers) {
      const value = headers[key];
      if (flat === null) flat = [];
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) flat.push(key, String(value[i]));
      } else {
        flat.push(key, String(value));
      }
    }
    return flat;
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
    if (this.headersSent || this._ended) return;

    // Fast-path JSON serialization for common API patterns
    let body: string;

    // The interpolated fast path is only valid when `success` is a real boolean
    // (a string/number would produce invalid JSON like {"success":yes,...});
    // otherwise fall through to JSON.stringify.
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

      // JSON.stringify(undefined) yields the literal token "undefined"; guard the
      // interpolated branches so an explicit `data: undefined` doesn't corrupt
      // the body (fall through to JSON.stringify, which omits the key instead).
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
      this._respondMaybeCompressed(body, 'application/json');
    } catch (err) {
      this._failSafe('Failed to send JSON response', err);
    }
  }

  // Buffered-response compression parity with the Node path. Terminal helper:
  // respond() with `body`, compressing first when enabled + compressible +
  // over threshold + the client accepts an encoding. Keeps the synchronous
  // fast path (zero extra work) whenever compression can't apply, so the
  // default (compression off) pays nothing.
  private _respondMaybeCompressed(body: string | Buffer, contentType?: string): void {
    const s = this._server._compression;
    // HOT PATH: compression is off by default - bail before ANY per-response
    // work (byteLength scans the string; header reads allocate nothing but
    // still cost). The default config must pay zero for this feature.
    if (!s.enabled) {
      this._engine.respond(this._reqId, this.statusCode, this._headersFlat(), body);
      this.headersSent = true;
      this._emitDone();
      return;
    }
    const bytes = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    const alreadyEncoded = 'content-encoding' in this.responseHeaders;
    const ctHeader = this.responseHeaders['content-type'];
    const ct = contentType ?? (Array.isArray(ctHeader) ? ctHeader[0] : ctHeader);
    if (
      alreadyEncoded ||
      bytes < s.threshold ||
      !isCompressible(ct) ||
      this.statusCode === 204 ||
      this.statusCode === 304
    ) {
      this._engine.respond(this._reqId, this.statusCode, this._headersFlat(), body);
      this.headersSent = true;
      this._emitDone();
      return;
    }

    const accept = this._engine.getHeader(this._reqId, 'accept-encoding') as string | undefined;
    const encoding = negotiateEncoding(accept, s.encodings);
    if (!encoding) {
      this._engine.respond(this._reqId, this.statusCode, this._headersFlat(), body);
      this.headersSent = true;
      this._emitDone();
      return;
    }

    // Async path: compress, then respond (guarding against an abort that
    // raced the await - the reqId would be invalid).
    void compressBuffer(body, encoding, s.level)
      .then(compressed => {
        if (this._ended || this._engine.isAborted(this._reqId)) return;
        this.responseHeaders['content-encoding'] = encoding;
        const vary = this.responseHeaders['vary'];
        this.responseHeaders['vary'] = vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding';
        this._engine.respond(this._reqId, this.statusCode, this._headersFlat(), compressed);
        this.headersSent = true;
        this._emitDone();
      })
      .catch(err => this._failSafe('Failed to compress response', err));
  }

  // A response-send failure must never leave the request hanging open (the
  // sweep exempts active requests, so nothing else would ever close it):
  // attempt a plain 500, then release the wrapper either way.
  private _failSafe(context: string, err: unknown) {
    this._logger.error(
      `${context}: ${err instanceof Error ? err.message : String(err)}`,
      'ResponseError'
    );
    if (!this._ended) {
      try {
        this._engine.respond(
          this._reqId,
          500,
          null,
          '{"success":false,"error":"Internal server error"}'
        );
        this.headersSent = true;
      } catch {
        // reqId already gone (aborted/finished) - nothing to send
      }
      this._emitDone();
    }
  }

  send(data: string | Buffer) {
    if (this.headersSent || this._ended) return;

    // Default a Content-Type to match the Node server (parity for the now-
    // default engine path): JSON for JSON-looking strings, octet-stream for
    // Buffers, text/plain otherwise.
    if (!('content-type' in this.responseHeaders)) {
      if (typeof data === 'string') {
        const t = data.trimStart();
        this.responseHeaders['content-type'] =
          t.startsWith('{') || t.startsWith('[')
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8';
      } else {
        this.responseHeaders['content-type'] = 'application/octet-stream';
      }
    }

    try {
      // Buffers pass through binary-safe (the engine accepts Uint8Array).
      // Compression applies only to compressible content types (isCompressible
      // excludes octet-stream), so binary sends stay on the sync fast path.
      this._respondMaybeCompressed(data);
      // headersSent/_emitDone handled inside the helper.
    } catch (err) {
      this._failSafe('Failed to send response', err);
    }
  }

  // Flush status + headers without ending the response (Node streaming
  // entry point - SSE and manual chunked responses start here). Supports
  // both (code, headers) and (code, statusMessage, headers) signatures;
  // the engine derives the reason phrase from the status code, so a custom
  // message cannot be sent on the wire and is ignored.
  writeHead(statusCode: number, reasonOrHeaders?: any, maybeHeaders?: any) {
    if (this.headersSent || this._ended) return this;

    this.statusCode = statusCode;
    const headers =
      reasonOrHeaders && typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
    if (headers) {
      for (const key of Object.keys(headers)) {
        this.setHeader(key, headers[key]);
      }
    }

    try {
      this._engine.writeHead(this._reqId, statusCode, this._headersFlat());
      this.headersSent = true;
    } catch {
      this._logger.error('Failed to write response head', 'ResponseError');
    }

    return this;
  }

  // Stream a body chunk, flushing the head first if needed. Returns the
  // engine's backpressure signal like Node's Writable.write; 'drain' fires
  // (via onWritable) when the socket can accept more.
  write(chunk: any, encoding?: any, callback?: any): boolean {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (this._ended) return false;

    let ok = true;
    try {
      if (!this.headersSent) {
        this._engine.writeHead(this._reqId, this.statusCode, this._headersFlat());
        this.headersSent = true;
      }
      ok = this._engine.write(this._reqId, chunk) !== false;
    } catch {
      this._logger.error('Failed to write response chunk', 'ResponseError');
      return false;
    }

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
    if (this._ended) {
      if (typeof callback === 'function') callback();
      return this;
    }

    try {
      if (!this.headersSent) {
        // Terminal single-shot: status + headers + body in one native call
        this._engine.respond(
          this._reqId,
          this.statusCode,
          this._headersFlat(),
          data !== undefined && data !== null ? data : null
        );
        this.headersSent = true;
      } else {
        this._engine.end(this._reqId, data !== undefined && data !== null ? data : undefined);
      }
      this._emitDone();
      if (typeof callback === 'function') callback();
    } catch (err) {
      this._failSafe('Failed to end response', err);
      if (typeof callback === 'function') callback();
    }

    return this;
  }

  redirect(url: string, code?: number) {
    if (this.headersSent || this._ended) return;

    const redirectCode = code || 302;
    this.statusCode = redirectCode;
    this.setHeader('location', url.replace(/[\r\n]/g, ''));

    try {
      this._engine.respond(this._reqId, redirectCode, this._headersFlat(), null);
      this.headersSent = true;
      this._emitDone();
    } catch (err) {
      this._failSafe('Failed to send redirect', err);
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
    // Percent-encode the value (matches the Node path and Express): an
    // unencoded value containing ';' or ',' would inject cookie attributes, and
    // control chars would make the native header validator silently drop the
    // whole Set-Cookie header.
    const parts = [name, '=', encodeURIComponent(value)];

    if (options) {
      // maxAge: 0 is meaningful (immediate expiry - clearCookie relies on it)
      if (options.maxAge !== undefined && options.maxAge !== null) {
        parts.push('; Max-Age=', String(options.maxAge));
      }
      if (options.expires) {
        const expires =
          options.expires instanceof Date ? options.expires.toUTCString() : String(options.expires);
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
    // Path defaults to '/' (Express behavior): without it the browser scopes
    // the cookie to the current URL's directory, so a clearCookie() from
    // /auth/logout would miss a cookie originally set at Path=/.
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

  // ==== File responses ====

  // Small files go out in one respond(); larger files stream with
  // backpressure ('drain' via the engine's onWritable)
  async sendFile(filePath: string): Promise<void> {
    if (this.headersSent || this._ended) return;

    let streamRef: any = null; // read stream, so the catch can tear it down
    try {
      const fs = await import('fs');
      const path = await import('path');
      const stats = await fs.promises.stat(filePath);

      const contentType = addCharsetIfNeeded(mimeTypeFor(path.extname(filePath)));
      if (!('content-type' in this.responseHeaders)) {
        this.setHeader('Content-Type', contentType);
      }
      this.setHeader('X-Content-Type-Options', 'nosniff');
      this.setHeader('Last-Modified', stats.mtime.toUTCString());
      this.setHeader('Cache-Control', 'public, max-age=31536000');

      if (stats.size <= SENDFILE_BUFFER_LIMIT) {
        const data = await fs.promises.readFile(filePath);
        this.end(data);
        return;
      }

      // Explicit length so the engine skips chunked encoding for the stream.
      // (If the file shrinks mid-stream, the engine detects the short write at
      // end() and forces Connection: close - the client sees truncation, never
      // the next response's bytes as this body.)
      this.setHeader('Content-Length', String(stats.size));
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        streamRef = stream;
        let pendingResume: (() => void) | null = null;
        // ONE close listener for the stream's whole lifetime (not one per
        // backpressure pause), and it SETTLES the promise: a client abort
        // while the stream is paused must not leave `await sendFile()`
        // hanging forever.
        const onClose = () => {
          if (pendingResume) this.removeListener('drain', pendingResume);
          stream.destroy();
          resolve();
        };
        this.once('close', onClose);
        const cleanup = () => {
          this.removeListener('close', onClose);
          if (pendingResume) this.removeListener('drain', pendingResume);
        };
        stream.on('data', chunk => {
          if (this._ended) {
            cleanup();
            stream.destroy();
            resolve();
            return;
          }
          if (!this.write(chunk)) {
            stream.pause();
            pendingResume = () => {
              pendingResume = null;
              stream.resume();
            };
            this.once('drain', pendingResume);
          }
        });
        stream.on('end', () => {
          cleanup();
          this.end();
          resolve();
        });
        stream.on('error', (err: Error) => {
          cleanup();
          reject(err);
        });
      });
    } catch {
      // The head may already be on the wire (streaming branch). Terminate the
      // response so the client isn't left waiting on the declared
      // Content-Length, and tear down the read stream; only 404 if nothing was
      // sent yet.
      if (streamRef) streamRef.destroy();
      if (this.headersSent && !this._ended) {
        this.end();
      } else if (!this.headersSent && !this._ended) {
        this.status(404).json({ success: false, error: 'File not found' });
      }
    }
  }

  attachment(filename?: string) {
    if (this.headersSent) return this;
    if (filename) {
      const safeName = filename.replace(/[\r\n"]/g, '');
      this.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      if (!this.getHeader('Content-Type')) {
        const dot = filename.lastIndexOf('.');
        if (dot !== -1) {
          this.setHeader('Content-Type', mimeTypeFor(filename.substring(dot)));
        }
      }
    } else {
      this.setHeader('Content-Disposition', 'attachment');
    }
    return this;
  }

  async download(filePath: string, filename?: string): Promise<void> {
    this.attachment(filename || filePath.split('/').pop());
    return this.sendFile(filePath);
  }

  format(handlers: Record<string, () => any | Promise<any>>): void {
    const types = Object.keys(handlers).filter(k => k !== 'default');
    const matched = this._moroReq ? this._moroReq.accepts(types) : false;
    const chosen = matched ? handlers[matched as string] : handlers.default;
    if (!chosen) {
      this.statusCode = 406;
      this.setHeader('Content-Type', 'text/plain; charset=utf-8');
      this.end('Not Acceptable');
      return;
    }
    this.vary('Accept');
    if (matched && typeof matched === 'string') {
      this.type(matched);
    }
    chosen();
  }

  // ==== Express-compatible response helpers (parity with the uWS adapter) ====

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
    // Reason phrase when the code is known, otherwise the code itself
    // (Node behavior) - never a fabricated "OK" for a non-2xx status.
    const statusString = STATUS_STRINGS.get(code);
    const body = statusString ? statusString.slice(String(code).length + 1) : String(code);
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
}

/**
 * Moro Engine HTTP Server Adapter
 * Bridges @morojs/engine with Moro's HTTP abstractions. Duck-typed to the
 * same surface framework.ts/moro.ts use on UWebSocketsHttpServer.
 */
export class MoroEngineServer {
  /** @internal read by EngineRequest/EngineResponse for lazy fetchers */
  _engine: any;
  /** @internal read by EngineRequest#protocol/socket.encrypted - true when the
   *  engine is terminating TLS for this server (engine >= 1.2.0 + ssl passed) */
  isSsl = false;

  private serverId: number;
  private globalMiddleware: Middleware[] = [];
  private logger = createFrameworkLogger('EngineHttpServer');
  private hookManager: any;
  private requestCounter = 0;
  private requestTrackingEnabled = true; // Generate request IDs (read lazily by EngineRequest)
  private isListening = false;
  private port?: number;
  private host?: string;
  // In-flight responses by reqId so onAborted/onWritable reach the wrappers;
  // entries are dropped on terminal writes (_complete) and aborts
  private inflight = new Map<number, EngineResponse>();
  // Small stable handle exposed via getServer()/getApp() (observability only)
  private handle: any;
  // Set by the engine WebSocket adapter when WS support is enabled; when
  // present, upgrade requests are routed to the engine's native WS path.
  // onOpen receives the handshake request's remote address and headers -
  // captured before the upgrade invalidates the reqId - so IP-based WS
  // rate limiting and header/token connection auth see real values.
  private _wsBridge?: {
    onOpen(
      wsId: number,
      path: string,
      info?: { ip: string; headers: Record<string, string> }
    ): void;
    onMessage(wsId: number, data: any, isBinary: boolean): void;
    onClose(wsId: number, code: number): void;
  };
  // Handshake info for the upgrade currently in flight: set just before
  // upgradeToWebSocket() (which fires onWsOpen synchronously), consumed there.
  private _pendingWsInfo?: { ip: string; headers: Record<string, string> } | undefined;

  // Body size limits (bytes) - configured from server.bodySizeLimit/maxUploadSize
  private maxBodySize: number = 10 * 1024 * 1024;
  private maxUploadSize: number = 100 * 1024 * 1024;
  private reusePort = false;
  private _capabilities?: EngineCapabilities;
  private _limits?: HttpRuntimeLimits;
  private _ssl?: Record<string, any>;
  private _http2Settings?: Http2ServerOptions;
  private multipartLimits?: MultipartLimits;
  /** @internal read by EngineResponse for buffered-response compression */
  _compression: CompressionSettings = {
    enabled: false,
    threshold: 1024,
    level: 6,
    encodings: ['br', 'gzip', 'deflate'],
  };
  // Set by close(); listen() then registers a fresh native server, because the
  // old serverId's uv handles are torn down and must never be reused.
  private closed = false;

  // Direct router dispatch (set from Moro.listen via setRouterHandler)
  private routerHandler?: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>;

  // Global error handler (Moro.setErrorHandler) - shapes errors thrown from
  // global middleware, hooks and body parsing (parity with MoroHttpServer)
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;

  // Direct route table (parity with MoroHttpServer): routes registered via
  // get/post/... - the framework's registerDirectRoutes() calls these. They
  // live here, independent of the UnifiedRouter singleton, so app.post()-style
  // routes keep working even if the unified router is reset (as the test
  // harness does between cases). Checked before the unified router in dispatch.
  private directRoutes: Array<{
    method: string;
    pattern: RegExp;
    paramNames: string[];
    handlers: Array<Middleware | HttpHandler>;
  }> = [];

  constructor(
    options: {
      /** Normalized SSL config projected for the engine (both shapes). */
      ssl?: Record<string, any> | null;
      /** Engine feature flags (from loadNativeEngine) - gates the ssl/http2/
       *  limit options so we never pass a key an older engine won't parse. */
      capabilities?: EngineCapabilities;
      /** Flattened runtime limits (bytes/ms) from the framework. */
      limits?: HttpRuntimeLimits;
      /** HTTP/2 settings when serving ALPN h2 natively (engine caps.http2). */
      http2Settings?: Http2ServerOptions;
      maxBodySize?: number;
      maxUploadSize?: number;
      /** Preloaded native engine module (from loadNativeEngine) - avoids a
       * second resolution and keeps load failures at the framework's
       * synchronous preflight instead of surfacing at listen() */
      engineModule?: any;
      /** Bind with SO_REUSEPORT so cluster workers can share the port
       * (POSIX only; the framework gates Windows clustering to Node) */
      reusePort?: boolean;
    } = {}
  ) {
    if (options.maxBodySize) this.maxBodySize = options.maxBodySize;
    if (options.maxUploadSize) this.maxUploadSize = options.maxUploadSize;
    this.reusePort = options.reusePort === true;
    if (options.capabilities) this._capabilities = options.capabilities;
    if (options.limits) this._limits = options.limits;
    if (options.ssl) this._ssl = options.ssl;
    if (options.http2Settings) this._http2Settings = options.http2Settings;
    if (options.limits?.multipart) this.multipartLimits = options.limits.multipart;

    // The framework preloads the engine synchronously (loadNativeEngine) and
    // injects it; loading here directly covers standalone construction.
    const engineModule = options.engineModule ?? loadNativeEngine()?.module;
    if (!engineModule) {
      throw new Error(
        'No native HTTP engine available: ' +
          (getNativeEngineLoadErrors().join('; ') || 'not installed')
      );
    }
    const surface = engineModule.default || engineModule;
    if (typeof surface.serve !== 'function' || typeof surface.respond !== 'function') {
      throw new Error(
        'Engine module does not provide the @morojs/engine API (serve/respond) - ' +
          'use UWebSocketsHttpServer for uWS-style modules'
      );
    }
    this._engine = surface;

    // TLS: pass it through when the engine supports it; otherwise keep the
    // (now capability-gated) warning so a proxy/node fallback is clear.
    if (this._ssl && this._capabilities?.tls) {
      this.isSsl = true; // req.secure/protocol now report https
    } else if (this._ssl && !this._capabilities?.tls) {
      this.logger.warn(
        'This @morojs/engine build does not terminate TLS - terminate at a ' +
          "proxy, upgrade the engine, or set engine: 'node' for in-process HTTPS",
        'Init'
      );
    }

    // Register callbacks now - the engine opens sockets only at listen().
    this.serverId = this.registerWithEngine();

    // Framework observability handle exposed via getServer()/getApp(). It
    // mimics enough of a net.Server that code reaching for the raw server
    // (e.g. `app.core.httpServer.getServer().close(cb)`) works on the engine
    // path too - address() is null until listening, and close(cb) forwards to
    // the adapter's shutdown so callers never hang waiting on a missing method.
    this.handle = Object.defineProperties(
      {
        engine: '@morojs/engine',
        address: () =>
          this.isListening
            ? { address: this.host || '0.0.0.0', family: 'IPv4', port: this.port || 0 }
            : null,
        close: (cb?: (err?: Error) => void) => {
          this.close(cb);
          return this.handle;
        },
      },
      {
        serverId: { get: () => this.serverId, enumerable: true },
        listening: { get: () => this.isListening, enumerable: true },
      }
    );

    this.logger.info('Moro engine HTTP server created', 'Init');
  }

  /** @internal terminal write/abort cleanup - drops the reqId mapping */
  _complete(reqId: number): void {
    this.inflight.delete(reqId);
  }

  // Register callbacks + limits with the native engine, returning the new
  // serverId. Called from the constructor and again by listen() after a
  // close() (the old native server is gone; a restart needs a fresh one).
  // The engine buffers bodies natively and 413s over its limit; it cannot
  // see content types, so it gets the larger upload limit and parseBody
  // enforces the tighter non-multipart limit (mirrors the other servers).
  //
  // Every option beyond maxBodySize/reusePort is gated on engine capabilities
  // so this never hands a key an older engine build cannot parse (an unknown
  // option would just be ignored, but gating keeps the intent explicit).
  private registerWithEngine(): number {
    const caps = this._capabilities;
    const limits = this._limits;
    const t = limits?.timeouts ?? {};
    const serveOptions: Record<string, any> = {
      maxBodySize: Math.max(this.maxBodySize, this.maxUploadSize),
      reusePort: this.reusePort,
    };
    // Timeouts + connection cap: understood since the engine's first release.
    if (t.idle !== undefined) serveOptions.idleTimeoutMs = t.idle;
    if (t.request !== undefined) serveOptions.requestTimeoutMs = t.request;
    if (limits?.maxConnections && limits.maxConnections > 0) {
      serveOptions.maxConnections = limits.maxConnections;
    }
    if (limits?.maxPendingBytes !== undefined) {
      serveOptions.maxPendingBytes = limits.maxPendingBytes;
    }
    // Full limit surface (engine >= 1.1.0).
    if (caps?.limits) {
      if (limits?.maxHeaderSize !== undefined) serveOptions.maxHeadSize = limits.maxHeaderSize;
      if (limits?.maxHeaders !== undefined) serveOptions.maxHeaders = limits.maxHeaders;
      if (limits?.wsMaxMessageSize !== undefined)
        serveOptions.wsMaxMessageSize = limits.wsMaxMessageSize;
      if (limits?.wsBackpressureLimit !== undefined)
        serveOptions.wsBackpressureLimit = limits.wsBackpressureLimit;
      if (limits?.writeHighWaterMark !== undefined)
        serveOptions.writeHighWaterMark = limits.writeHighWaterMark;
      if (limits?.backlog !== undefined) serveOptions.backlog = limits.backlog;
    }
    // TLS: gated on the engine's own capability flag (caps.tls), not a version
    // number, so a mismatched engine build is never handed an ssl option it
    // can't parse.
    if (caps?.tls && this._ssl) {
      serveOptions.ssl = this._ssl;
    }
    // HTTP/2: likewise gated on caps.http2.
    if (caps?.http2 && this._http2Settings) {
      serveOptions.http2 = {
        ...(this._http2Settings.settings ?? {}),
      };
    }
    return this._engine.serve(
      {
        onRequest: (reqId: number, methodIdx: number, path: string) =>
          this.onRequest(reqId, methodIdx, path),
        onAborted: (reqId: number) => this.onAborted(reqId),
        onWritable: (reqId: number) => this.onWritable(reqId),
        onWsOpen: (wsId: number, path: string) =>
          this._wsBridge?.onOpen(wsId, path, this._pendingWsInfo),
        onWsMessage: (wsId: number, data: any, isBinary: boolean) =>
          this._wsBridge?.onMessage(wsId, data, isBinary),
        onWsClose: (wsId: number, code: number) => this._wsBridge?.onClose(wsId, code),
      },
      serveOptions
    );
  }

  // ---- WebSocket bridge (used by EngineWebSocketAdapter) ----

  /** Register the engine WebSocket bridge; upgrade requests then route natively. */
  enableWebSocket(bridge: {
    onOpen(wsId: number, path: string): void;
    onMessage(wsId: number, data: any, isBinary: boolean): void;
    onClose(wsId: number, code: number): void;
  }): void {
    this._wsBridge = bridge;
  }

  /** Send a frame on a WebSocket. Returns false on backpressure. */
  wsSend(wsId: number, data: string | ArrayBuffer | Buffer, isBinary: boolean): boolean {
    return this._engine.wsSend(wsId, data, isBinary) !== false;
  }

  /** Close a WebSocket (RFC 6455 close frame). */
  wsClose(wsId: number, code?: number, reason?: string): void {
    this._engine.wsClose(wsId, code, reason);
  }

  // Direct router dispatch - called after global middleware without the
  // per-middleware promise machinery (mirrors MoroHttpServer.setRouterHandler)
  setRouterHandler(fn: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>): void {
    this.routerHandler = fn;
  }

  // Register a global error handler (called from Moro.setErrorHandler)
  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): void {
    this.errorHandler = fn;
  }

  // Request/response decorations (app.decorateRequest/decorateReply). Applied
  // per request/response since EngineRequest/EngineResponse are shared classes
  // (decorating their prototype would leak across apps in one process). Empty
  // by default, so the common path pays only a `> 0` length check.
  private requestDecorationKeys: string[] = [];
  private requestDecorations: Record<string, any> = {};
  private responseDecorationKeys: string[] = [];
  private responseDecorations: Record<string, any> = {};

  setRequestDecorations(decorations: Record<string, any>): void {
    this.requestDecorations = decorations;
    this.requestDecorationKeys = Object.keys(decorations);
  }

  setResponseDecorations(decorations: Record<string, any>): void {
    this.responseDecorations = decorations;
    this.responseDecorationKeys = Object.keys(decorations);
  }

  // Direct route registration (mirrors MoroHttpServer). The framework's
  // registerDirectRoutes() invokes these as httpServer[method](path, handler).
  private addDirectRoute(
    method: string,
    path: string,
    handlers: Array<Middleware | HttpHandler>
  ): void {
    const compiled = PathMatcher.compile(path);
    const pattern =
      compiled.pattern || new RegExp(`^${(path.split('?')[0] ?? '').replace(/\//g, '\\/')}$`);
    this.directRoutes.push({ method, pattern, paramNames: compiled.paramNames, handlers });
  }

  get(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('GET', path, handlers);
  }
  post(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('POST', path, handlers);
  }
  put(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('PUT', path, handlers);
  }
  delete(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('DELETE', path, handlers);
  }
  patch(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('PATCH', path, handlers);
  }
  options(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('OPTIONS', path, handlers);
  }
  head(path: string, ...handlers: Array<Middleware | HttpHandler>): void {
    this.addDirectRoute('HEAD', path, handlers);
  }

  // Match + run a direct route. Returns true if one handled the request.
  private async dispatchDirectRoute(
    httpReq: EngineRequest,
    httpRes: EngineResponse
  ): Promise<boolean> {
    if (this.directRoutes.length === 0) return false;
    const method = httpReq.method;
    const path = httpReq.path;
    for (const route of this.directRoutes) {
      if (route.method !== method) continue;
      const matches = path.match(route.pattern);
      if (!matches) continue;

      if (route.paramNames.length > 0) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const paramName = route.paramNames[i];
          if (paramName === undefined) continue;
          const raw = matches[i + 1];
          if (raw === undefined) {
            params[paramName] = '';
          } else {
            // Malformed escapes (e.g. /users/%zz) keep the raw text - a
            // URIError here would turn an odd URL into a 500
            try {
              params[paramName] = decodeURIComponent(raw);
            } catch {
              params[paramName] = raw;
            }
          }
        }
        httpReq.params = { ...httpReq.params, ...params };
      }

      // Run the handler chain: middleware-style (req,res,next) links run in
      // order; the final handler's return value (if any) is sent as JSON.
      for (let i = 0; i < route.handlers.length; i++) {
        if (httpRes.headersSent) break;
        const handler = route.handlers[i] as any;
        const isLast = i === route.handlers.length - 1;
        if (isLast) {
          const result = handler(httpReq as any, httpRes as any);
          const value = result && typeof result.then === 'function' ? await result : result;
          if (value !== undefined && !httpRes.headersSent) {
            (httpRes as any).json(value);
          }
        } else {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const done = (err?: Error) => {
              if (settled) return;
              settled = true;
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            };
            try {
              const r = handler(httpReq as any, httpRes as any, done);
              if (r && typeof r.then === 'function') {
                r.then(() => done(), done);
              } else if (httpRes.headersSent) {
                // A middleware that ended the response without calling next()
                // would otherwise leave this await unresolved - unblock the chain.
                done();
              }
            } catch (e) {
              done(e as Error);
            }
          });
        }
      }
      return true;
    }
    return false;
  }

  // The engine has no native route table - every request already reaches the
  // unified router through a single onRequest callback with zero middleware
  // machinery, so there is no fast path to register. Accepted for interface
  // parity with the uWS adapter.
  setNativeRouteProvider(_provider: () => Array<any>, _onError?: (...args: any[]) => any): void {
    this.logger.debug(
      'Native route provider noted (engine dispatch is already direct)',
      'NativeRoutes'
    );
  }

  private onRequest(reqId: number, methodIdx: number, path: string): void {
    // WebSocket upgrade: when a WS bridge is registered and this is an upgrade
    // request, hand the connection to the engine's native WS path. The engine
    // sends the 101 handshake and drives onWsOpen/Message/Close.
    if (this._wsBridge) {
      const upgrade = this._engine.getHeader(reqId, 'upgrade');
      if (upgrade && upgrade.toLowerCase() === 'websocket') {
        // Snapshot handshake data now - the upgrade invalidates the reqId,
        // after which these fetchers return empty values.
        const ip: string = this._engine.getRemoteAddress(reqId) || '';
        const headers: Record<string, string> = {};
        const flat: string[] | undefined = this._engine.getHeaders(reqId);
        if (flat) {
          // Join duplicates exactly like the EngineRequest.headers getter -
          // last-wins would let a client send two X-Forwarded-For lines and
          // hide the earlier one from IP-based WS auth / rate-limiting.
          for (let i = 0; i + 1 < flat.length; i += 2) {
            const key = flat[i];
            const val = flat[i + 1];
            if (key === undefined || val === undefined) continue;
            const existing = headers[key];
            headers[key] =
              existing === undefined ? val : existing + (key === 'cookie' ? '; ' : ', ') + val;
          }
        }
        this._pendingWsInfo = { ip, headers };
        const wsId = this._engine.upgradeToWebSocket(reqId);
        this._pendingWsInfo = undefined;
        if (wsId !== -1) return; // WS took over this connection
        // else: not a valid upgrade - fall through to normal HTTP handling
      }
    }

    // methodIdx 7 (OTHER) needs the extra crossing; the seven common methods
    // resolve from the static table
    const method = methodIdx === 7 ? this._engine.getMethod(reqId) || 'OTHER' : METHODS[methodIdx];

    const httpReq = new EngineRequest(this, reqId, method, path);
    const httpRes = new EngineResponse(this, reqId, this.logger);
    httpRes._moroReq = httpReq;

    // Apply app.decorateRequest/decorateReply values (rare; opt-in)
    if (this.requestDecorationKeys.length > 0) {
      for (const key of this.requestDecorationKeys) {
        (httpReq as any)[key] = this.requestDecorations[key];
      }
    }
    if (this.responseDecorationKeys.length > 0) {
      for (const key of this.responseDecorationKeys) {
        (httpRes as any)[key] = this.responseDecorations[key];
      }
    }

    void this.handleRequest(httpReq, httpRes);

    // Register for onAborted/onWritable routing only when the response is
    // still in flight after the synchronous dispatch window. Sync handlers
    // have already ended by here, and the engine never fires those callbacks
    // for a completed reqId - registering every request just churns this
    // long-lived Map's old-space backing store, and entries alive at a
    // scavenge promote the whole request/response graph (at ~570k pipelined
    // req/s that meant full GCs every ~400ms and a ~150 MB heap vs ~30 MB).
    if (!httpRes.writableEnded) this.inflight.set(reqId, httpRes);
  }

  private onAborted(reqId: number): void {
    const httpRes = this.inflight.get(reqId);
    if (httpRes) {
      this.inflight.delete(reqId);
      httpRes._handleAbort();
    }
  }

  private onWritable(reqId: number): void {
    const httpRes = this.inflight.get(reqId);
    if (httpRes) httpRes._handleWritable();
  }

  private async handleRequest(httpReq: EngineRequest, httpRes: EngineResponse): Promise<void> {
    this.requestCounter++;

    try {
      const method = httpReq.method;

      // Parse body only for body methods (all start with 'P'). The engine
      // buffered the body before onRequest fired, so this is synchronous.
      if (
        method.charCodeAt(0) === 80 && // 'P' char code
        (method === 'POST' || method === 'PUT' || method === 'PATCH')
      ) {
        this.parseBody(httpReq);
      }

      // Execute hooks before request processing - skipped entirely when none registered
      const hookManager = this.hookManager;
      if (hookManager && (hookManager.hasHooks === undefined || hookManager.hasHooks('request'))) {
        await hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // Execute global middleware chain
      if (this.globalMiddleware.length > 0) {
        await this.executeMiddleware(
          this.globalMiddleware,
          httpReq as any as HttpRequest,
          httpRes as any as HttpResponse
        );
        if (httpRes.headersSent) return;
      }

      // Unified router first - it carries the full route feature set
      // (per-route middleware, validation, auth, ...). The direct route table
      // below is only a fallback for when the unified router singleton was
      // reset out from under a listening app (as the test harness does), so it
      // must never shadow the richer unified-router path.
      const routerHandler = this.routerHandler;
      if (routerHandler) {
        const handled = routerHandler(
          httpReq as any as HttpRequest,
          httpRes as any as HttpResponse
        );
        if (handled) {
          if (typeof (handled as any).then === 'function') {
            if (await handled) return;
          } else {
            return;
          }
        }
      }

      // Direct route table fallback (parity with node's dual registration -
      // survives a UnifiedRouter reset)
      if (await this.dispatchDirectRoute(httpReq, httpRes)) return;

      // No route matched
      if (!httpRes.headersSent && !httpRes.writableEnded) {
        httpRes.statusCode = 404;
        httpRes.setHeader('Content-Type', 'application/json');
        httpRes.end('{"success":false,"error":"Not found"}');
      }
    } catch (error) {
      // Payload-too-large: respond 413 rather than a generic 500
      if ((error as any)?.statusCode === 413 && !httpRes.writableEnded && !httpRes.headersSent) {
        httpRes.statusCode = 413;
        httpRes.setHeader('Content-Type', 'application/json');
        httpRes.end('{"success":false,"error":"Request entity too large"}');
        return;
      }

      // Malformed body (parseBody): a client error, not a server error
      if ((error as any)?.statusCode === 400 && !httpRes.writableEnded && !httpRes.headersSent) {
        httpRes.statusCode = 400;
        httpRes.setHeader('Content-Type', 'application/json');
        httpRes.end('{"success":false,"error":"Invalid request body"}');
        return;
      }

      this.logger.error(
        `Request handling error: ${error instanceof Error ? error.message : String(error)}`,
        'RequestError'
      );

      // The app's global error handler (Moro.setErrorHandler) gets first shot
      // at shaping the response - same contract as the Node server.
      if (this.errorHandler && !httpRes.writableEnded && !httpRes.headersSent) {
        try {
          await this.errorHandler(
            error,
            httpReq as any as HttpRequest,
            httpRes as any as HttpResponse
          );
          if (httpRes.headersSent || httpRes.writableEnded) return;
        } catch (handlerError) {
          this.logger.error(
            `Error handler threw: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
            'ErrorHandler'
          );
        }
      }

      // Send error response if not already sent
      if (!httpRes.writableEnded && !httpRes.headersSent) {
        try {
          httpRes.statusCode = 500;
          httpRes.setHeader('Content-Type', 'application/json');
          httpRes.end('{"success":false,"error":"Internal server error"}');
        } catch {
          this.logger.error('Failed to send error response', 'ResponseError');
        }
      }
    }
  }

  // Parse the engine-buffered body (JSON/urlencoded/multipart/text - identical
  // semantics to the Node and uWS servers' readBody). getBody returns a STABLE
  // ArrayBuffer copy, so Buffer.from() views it with no aliasing hazard.
  private parseBody(httpReq: EngineRequest): void {
    const raw: ArrayBuffer | null = this._engine.getBody(httpReq._reqId);
    if (!raw || raw.byteLength === 0) return;

    const contentType = httpReq.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');
    const maxSize = isMultipart ? this.maxUploadSize : this.maxBodySize;

    // The engine natively enforces the larger of the two limits; the tighter
    // non-multipart limit is enforced here (responds 413 via handleRequest)
    if (raw.byteLength > maxSize) {
      const error: any = new Error(
        isMultipart ? 'File upload too large' : 'Request body too large'
      );
      error.statusCode = 413;
      throw error;
    }

    const buffer = Buffer.from(raw);

    try {
      if (contentType.includes('application/json')) {
        httpReq.body = JSON.parse(buffer.toString('utf-8'));
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(buffer.toString('utf-8'));
        const body: Record<string, any> = {};
        params.forEach((value, key) => {
          body[key] = value;
        });
        httpReq.body = body;
      } else if (isMultipart) {
        // Shared parser (same as the Node/uWS servers) - stringifying
        // multipart would corrupt binary uploads and lose fields/files
        httpReq.body = parseMultipartBuffer(buffer, contentType, this.multipartLimits);
      } else {
        httpReq.body = buffer.toString('utf-8');
      }
    } catch (parseError) {
      // A limit error (multipart maxParts/maxFiles/maxFileSize) carries its own
      // 413 - preserve it rather than masking it as a generic 400 malformed.
      if (parseError && typeof (parseError as any).statusCode === 'number') {
        throw parseError;
      }
      // A malformed body must fail the request (Node-path parity), not slip a
      // silent `body = null` past handlers that then treat it as "no input".
      const error: any = new Error(
        `Invalid request body: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      );
      error.statusCode = 400;
      throw error;
    }
  }

  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    // Express error semantics: a middleware that calls next(err) (or throws)
    // routes to the NEXT 4-arg error handler (err, req, res, next), skipping
    // the normal 3-arg middleware in between; normal middleware is skipped
    // while an error is pending, and error handlers are skipped when there is
    // no error. An uncaught error propagates to handleRequest's 500 path.
    let error: any = null;
    for (const mw of middleware) {
      if (res.headersSent) break;
      const isErrorHandler = (mw as any).length >= 4;
      if (error && !isErrorHandler) continue;
      if (!error && isErrorHandler) continue;

      try {
        await new Promise<void>((resolve, reject) => {
          const next = (err?: any) => (err ? reject(err) : resolve());
          try {
            const result = error ? (mw as any)(error, req, res, next) : mw(req, res, next);
            if (result && typeof result.then === 'function') {
              result.then(() => resolve(), reject);
            }
          } catch (e) {
            reject(e);
          }
        });
        error = null; // handler (error or normal) completed cleanly
      } catch (e) {
        error = e; // route to the next error handler
      }
    }
    if (error) throw error;
  }

  // Public API - matches MoroHttpServer/UWebSocketsHttpServer interface

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

  // Note: Route registration methods (get, post, etc.) are not used by the
  // engine adapter - all routing is handled by UnifiedRouter via setRouterHandler
  // (same as the uWS adapter)

  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  configurePerformance(config: any): void {
    // The engine's request hot path is batched natively; the one thing it
    // does NOT do itself is response compression, so wire that here (parity
    // with the Node path). Buffered responses only - streaming stays raw.
    this._compression = resolveCompressionSettings(config);
    this.logger.debug(
      `Performance configured (compression ${this._compression.enabled ? 'on' : 'off'})`,
      'Config'
    );
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void): void {
    if (this.isListening) {
      this.logger.warn('Server is already listening', 'Listen');
      return;
    }

    const host = typeof hostOrCallback === 'string' ? hostOrCallback : '0.0.0.0';
    const cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;

    try {
      // listen() after close(): the old native server's handles are torn
      // down (its serverId is dead) - register a fresh one, like a Node
      // http.Server supports close() -> listen() cycles.
      if (this.closed) {
        this.serverId = this.registerWithEngine();
        this.closed = false;
      }
      // Synchronous bind; throws on bind errors, returns the actual port
      // (meaningful when port 0 asks for an ephemeral one)
      const actualPort = this._engine.listen(this.serverId, host, port);
      this.port = typeof actualPort === 'number' ? actualPort : port;
      this.host = host;
      this.isListening = true;
      this.logger.info(`Moro engine HTTP server listening on ${host}:${this.port}`, 'Listen');
      if (cb) cb();
    } catch (error) {
      this.logger.error(
        `Failed to listen on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
        'Listen'
      );
      throw error;
    }
  }

  /** Bounded drain window for in-flight responses during close() */
  private static readonly CLOSE_DRAIN_MS = 2000;

  close(callback?: (error?: Error) => void): void {
    if (!this.isListening) {
      if (callback) callback();
      return;
    }

    try {
      this.isListening = false;
      this.closed = true;

      // Graceful shutdown: stop accepting first, give in-flight responses a
      // bounded window to finish, then tear down. Requests still open at
      // teardown get onAborted -> 'close' events, so SSE intervals/monitors
      // registered on req.on('close') are released, not leaked.
      // Middleware is intentionally kept: close() -> listen() must serve with
      // the same cors/auth/compression stack (Node http.Server parity).
      if (typeof this._engine.stopListening === 'function') {
        this._engine.stopListening(this.serverId);
      }

      const finish = () => {
        try {
          this._engine.close(this.serverId);
        } catch (error) {
          this.logger.error('Error closing server', 'Close', {
            error: error instanceof Error ? error.message : String(error),
          });
          if (callback) callback(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.inflight.clear();
        this.logger.info('Moro engine HTTP server closed', 'Close');
        if (callback) {
          // Give the event loop time to process the engine's socket teardown
          // before invoking the callback (matches the uWS adapter)
          setTimeout(() => {
            callback();
          }, 50);
        }
      };

      if (this.inflight.size === 0) {
        finish();
        return;
      }
      const deadline = Date.now() + MoroEngineServer.CLOSE_DRAIN_MS;
      const poll = setInterval(() => {
        if (this.inflight.size === 0 || Date.now() >= deadline) {
          clearInterval(poll);
          finish();
        }
      }, 25);
      // The drain poll must never keep the process alive by itself
      (poll as any).unref?.();
    } catch (error) {
      this.logger.error('Error closing server', 'Close', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (callback) callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getServer(): any {
    // Stable observability handle (listening/address) - there is no app object
    return this.handle;
  }

  getApp(): any {
    return this.handle;
  }

  forceCleanup(): void {
    // Cleanup method for compatibility
    this.logger.debug('Force cleanup called', 'Cleanup');
  }
}
