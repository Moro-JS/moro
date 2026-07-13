// src/core/http-server.ts
import { IncomingMessage, ServerResponse, createServer, Server } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../logger/index.js';
import {
  parseMultipart as parseMultipartBuffer,
  type MultipartLimits,
} from './utils/multipart-parser.js';
import { parseRawQueryString } from './utils/query-parser.js';
import type { HttpRuntimeLimits } from './utils/size.js';
import {
  HttpRequest,
  HttpResponse,
  HttpHandler,
  Middleware,
  RouteEntry,
} from '../../types/http.js';
import { PathMatcher } from '../routing/path-matcher.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const STATUS_MESSAGES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const TYPE_SHORTHANDS: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  js: 'application/javascript',
  css: 'text/css; charset=utf-8',
  form: 'application/x-www-form-urlencoded',
};

// Canonical query parsing shared with the uWS/engine transports - identical
// req.query semantics everywhere ('+' as space, malformed escapes tolerated).
const parseQueryString = parseRawQueryString;

function parseCookieHeader(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  const cookieParts = cookieHeader.split(';');
  const cookiePartsLen = cookieParts.length;
  for (let i = 0; i < cookiePartsLen; i++) {
    const cookie = cookieParts[i];
    if (cookie === undefined) continue;
    const equalIndex = cookie.indexOf('=');
    if (equalIndex > 0) {
      const name = cookie.substring(0, equalIndex).trim();
      const value = cookie.substring(equalIndex + 1);
      if (name && value) {
        try {
          cookies[name] = decodeURIComponent(value);
        } catch {
          // Malformed percent-encoding: keep the raw value rather than throwing a 500
          cookies[name] = value;
        }
      }
    }
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Prototype-based request/response enhancement.
//
// All helper methods live on shared prototypes (defined once per process)
// instead of being re-created as ~40 closures on every request, and derived
// request fields (query, cookies, hostname, ips, ...) are lazy memoized
// getters so a request only pays for what its handler actually reads.
// Each MoroHttpServer binds per-instance subclasses whose prototype carries
// the `_server` back-reference, so methods can reach server config (logger,
// compression settings) without any per-request allocation.
// ---------------------------------------------------------------------------

export class MoroIncomingMessage extends IncomingMessage {
  /** Bound on the per-server subclass prototype - no per-request write needed */
  declare _server: MoroHttpServer;

  // Hot per-request fields (assigned in handleRequest; declared here for
  // stable shape). Everything else lives behind the single `_lazy` slot -
  // per-request construction pays 5 field initializations instead of 16.
  params: Record<string, string> = {};
  body: any = null;
  path = '';
  _queryString: string | null = null;

  // Single slot for every lazily-computed/assigned helper value (query,
  // cookies, requestId, hostname, ...). Allocated on first access - a plain
  // JSON GET that never touches the helpers never allocates it, and the
  // request object keeps one stable hidden-class shape either way.
  _lazy: Record<string, any> | undefined = undefined;

  get query(): Record<string, string> {
    const L = this._lazy ?? (this._lazy = {});
    let q = L.query;
    if (q === undefined) {
      const qs = this._queryString;
      q = qs ? parseQueryString(qs) : {};
      L.query = q;
    }
    return q;
  }
  set query(value: Record<string, string>) {
    (this._lazy ?? (this._lazy = {})).query = value;
  }

  get cookies(): Record<string, string> {
    const L = this._lazy ?? (this._lazy = {});
    let c = L.cookies;
    if (c === undefined) {
      const header = this.headers.cookie;
      c = header ? parseCookieHeader(header) : {};
      L.cookies = c;
    }
    return c;
  }
  set cookies(value: Record<string, string>) {
    (this._lazy ?? (this._lazy = {})).cookies = value;
  }

  get context(): Record<string, any> {
    const L = this._lazy ?? (this._lazy = {});
    let ctx = L.context;
    if (ctx === undefined) {
      ctx = {};
      L.context = ctx;
    }
    return ctx;
  }
  set context(value: Record<string, any>) {
    (this._lazy ?? (this._lazy = {})).context = value;
  }

  get requestId(): string {
    const L = this._lazy ?? (this._lazy = {});
    let id = L.requestId;
    if (id === undefined) {
      const server = this._server;
      id = server && server.requestTrackingEnabled ? randomUUID() : '';
      L.requestId = id;
    }
    return id;
  }
  set requestId(value: string) {
    (this._lazy ?? (this._lazy = {})).requestId = value;
  }

  get ip(): string {
    const L = this._lazy ?? (this._lazy = {});
    let v = L.ip;
    if (v === undefined) {
      v = (this.socket && this.socket.remoteAddress) || '';
      L.ip = v;
    }
    return v;
  }
  set ip(value: string) {
    (this._lazy ?? (this._lazy = {})).ip = value;
  }

  get originalUrl(): string {
    const v = this._lazy?.originalUrl;
    return v !== undefined ? v : this.url || '';
  }
  set originalUrl(value: string) {
    (this._lazy ?? (this._lazy = {})).originalUrl = value;
  }

  get hostname(): string {
    const L = this._lazy ?? (this._lazy = {});
    let v = L.hostname;
    if (v === undefined) {
      const host = (this.headers.host || '') as string;
      v = host ? host.split(':')[0] : '';
      L.hostname = v;
    }
    return v;
  }
  set hostname(value: string) {
    (this._lazy ?? (this._lazy = {})).hostname = value;
  }

  get protocol(): string {
    const L = this._lazy ?? (this._lazy = {});
    let v = L.protocol;
    if (v === undefined) {
      const forwardedProto = this.headers['x-forwarded-proto'] as string | undefined;
      v = forwardedProto
        ? (forwardedProto.split(',')[0] ?? '').trim()
        : (this.socket as any)?.encrypted
          ? 'https'
          : 'http';
      L.protocol = v;
    }
    return v;
  }
  set protocol(value: string) {
    (this._lazy ?? (this._lazy = {})).protocol = value;
  }

  get secure(): boolean {
    const v = this._lazy?.secure;
    return v !== undefined ? v : this.protocol === 'https';
  }
  set secure(value: boolean) {
    (this._lazy ?? (this._lazy = {})).secure = value;
  }

  get xhr(): boolean {
    const L = this._lazy ?? (this._lazy = {});
    let v = L.xhr;
    if (v === undefined) {
      const xrw = this.headers['x-requested-with'] as string | undefined;
      v = !!xrw && xrw.toLowerCase() === 'xmlhttprequest';
      L.xhr = v;
    }
    return v;
  }
  set xhr(value: boolean) {
    (this._lazy ?? (this._lazy = {})).xhr = value;
  }

  get ips(): string[] {
    const L = this._lazy ?? (this._lazy = {});
    let v = L.ips;
    if (v === undefined) {
      const forwardedFor = this.headers['x-forwarded-for'] as string | undefined;
      v = forwardedFor
        ? forwardedFor
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [];
      L.ips = v;
    }
    return v;
  }
  set ips(value: string[]) {
    (this._lazy ?? (this._lazy = {})).ips = value;
  }

  get subdomains(): string[] {
    const L = this._lazy ?? (this._lazy = {});
    let v = L.subdomains;
    if (v === undefined) {
      const hostnameParts = this.hostname.split('.');
      // Matches Express: subdomains are parts before the last two (domain + tld),
      // reversed (closest subdomain first).
      v = hostnameParts.length > 2 ? hostnameParts.slice(0, -2).reverse() : [];
      L.subdomains = v;
    }
    return v;
  }
  set subdomains(value: string[]) {
    (this._lazy ?? (this._lazy = {})).subdomains = value;
  }

  // Express-compatible request helpers (shared prototype methods, not closures)
  get(name: string): string | undefined {
    const lower = name.toLowerCase();
    if (lower === 'referer' || lower === 'referrer') {
      return (this.headers.referer || (this.headers as any).referrer) as string | undefined;
    }
    const v = this.headers[lower];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  }

  header(name: string): string | undefined {
    return this.get(name);
  }

  is(type: string): boolean {
    const ct = (this.headers['content-type'] || '') as string;
    if (!ct) return false;
    const mime = (ct.split(';')[0] ?? '').trim().toLowerCase();
    const t = type.toLowerCase();
    if (t.indexOf('/') === -1) {
      // e.g. 'json' → match */json or +json suffix
      return mime.endsWith(`/${t}`) || mime.endsWith(`+${t}`);
    }
    if (t.endsWith('/*')) {
      return mime.startsWith(t.slice(0, -1));
    }
    return mime === t;
  }

  accepts(types?: string | string[]): string | false {
    const accept = (this.headers.accept || '*/*') as string;
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
    const acceptLang = (this.headers['accept-language'] || '') as string;
    if (!langs) return acceptLang || false;
    const wanted = Array.isArray(langs) ? langs : [langs];
    if (!acceptLang) return wanted[0] || false;
    // Parse with q values; sort by q desc to match Express's "best match wins"
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

export class MoroServerResponse extends ServerResponse {
  /** Bound on the per-server subclass prototype - no per-request write needed */
  declare _server: MoroHttpServer;

  _locals: Record<string, any> | undefined = undefined;

  get locals(): Record<string, any> {
    let l = this._locals;
    if (l === undefined) {
      l = {};
      this._locals = l;
    }
    return l;
  }
  set locals(value: Record<string, any>) {
    this._locals = value;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(data: any): void {
    if (this.headersSent) return;

    const jsonString = JSON.stringify(data);
    const server = this._server;

    // Compression - EARLY EXIT if disabled or below threshold
    if (server && server.compressionEnabled && jsonString.length > server.compressionThreshold) {
      const acceptEncoding = (this as any).req?.headers['accept-encoding'];

      if (acceptEncoding && acceptEncoding.includes('gzip')) {
        const buffer = Buffer.from(jsonString, 'utf8');
        gzip(buffer)
          .then(compressed => {
            if (this.headersSent) return;
            this.writeHead(this.statusCode || 200, {
              'Content-Type': JSON_CONTENT_TYPE,
              'Content-Encoding': 'gzip',
              Vary: 'Accept-Encoding',
              'Content-Length': compressed.length,
            });
            this.end(compressed);
          })
          .catch(err => {
            server.logger.error('Response compression failed', 'HttpServer', {
              error: err instanceof Error ? err.message : String(err),
            });
            if (!this.headersSent) {
              this.writeHead(this.statusCode || 200, {
                'Content-Type': JSON_CONTENT_TYPE,
                'Content-Length': Buffer.byteLength(jsonString),
              });
              this.end(jsonString);
            } else {
              this.end();
            }
          });
        return;
      } else if (acceptEncoding && acceptEncoding.includes('deflate')) {
        const buffer = Buffer.from(jsonString, 'utf8');
        deflate(buffer)
          .then(compressed => {
            if (this.headersSent) return;
            this.writeHead(this.statusCode || 200, {
              'Content-Type': JSON_CONTENT_TYPE,
              'Content-Encoding': 'deflate',
              Vary: 'Accept-Encoding',
              'Content-Length': compressed.length,
            });
            this.end(compressed);
          })
          .catch(err => {
            server.logger.error('Response compression failed', 'HttpServer', {
              error: err instanceof Error ? err.message : String(err),
            });
            if (!this.headersSent) {
              this.writeHead(this.statusCode || 200, {
                'Content-Type': JSON_CONTENT_TYPE,
                'Content-Length': Buffer.byteLength(jsonString),
              });
              this.end(jsonString);
            } else {
              this.end();
            }
          });
        return;
      }
    }

    // SYNC PATH - no compression: single serialize, single write, no Buffer copy
    this.writeHead(this.statusCode || 200, {
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(jsonString),
    });
    this.end(jsonString);
  }

  send(data: string | Buffer): void {
    if (this.headersSent) return;

    // Auto-detect content type if not already set
    if (!this.getHeader('Content-Type')) {
      if (typeof data === 'string') {
        // Cheap JSON sniff: first non-whitespace char is '{', '[' or '"'
        // (replaces a full JSON.parse of the body just to pick a content type)
        let i = 0;
        const len = data.length;
        while (i < len) {
          const c = data.charCodeAt(i);
          if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
          i++;
        }
        const first = i < len ? data.charCodeAt(i) : 0;
        if (first === 123 /* { */ || first === 91 /* [ */ || first === 34 /* " */) {
          this.setHeader('Content-Type', JSON_CONTENT_TYPE);
        } else {
          this.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
      } else {
        this.setHeader('Content-Type', 'application/octet-stream');
      }
    }

    this.end(data);
  }

  cookie(name: string, value: string, options: any = {}): this {
    if (this.headersSent) {
      const isCritical =
        options.critical ||
        name.includes('session') ||
        name.includes('auth') ||
        name.includes('csrf');
      const message = `Cookie '${name}' could not be set - headers already sent`;

      if (isCritical || options.throwOnLateSet) {
        throw new Error(`${message}. This may cause authentication or security issues.`);
      } else {
        this._server?.logger.warn(message, 'CookieWarning', {
          cookieName: name,
          critical: isCritical,
          stackTrace: new Error().stack,
        });
      }
      return this;
    }

    const cookieValue = encodeURIComponent(value);
    let cookieString = `${name}=${cookieValue}`;

    // maxAge: 0 is meaningful (immediate expiry - clearCookie relies on it)
    if (options.maxAge !== undefined && options.maxAge !== null)
      cookieString += `; Max-Age=${options.maxAge}`;
    if (options.expires) cookieString += `; Expires=${options.expires.toUTCString()}`;
    if (options.httpOnly) cookieString += '; HttpOnly';
    if (options.secure) cookieString += '; Secure';
    if (options.sameSite) cookieString += `; SameSite=${options.sameSite}`;
    if (options.domain) cookieString += `; Domain=${options.domain}`;
    // Path defaults to '/' (Express behavior) so clearCookie() from a nested
    // route can clear a cookie originally set at the site root.
    cookieString += `; Path=${options.path ?? '/'}`;

    const existingCookies = this.getHeader('Set-Cookie') || [];
    // Avoid spread operator - direct array manipulation
    const cookies = Array.isArray(existingCookies) ? existingCookies : [existingCookies as string];
    cookies.push(cookieString);
    this.setHeader('Set-Cookie', cookies);

    return this;
  }

  clearCookie(name: string, options: any = {}): this {
    // Avoid spread operator - manually set properties
    const clearOptions: any = {
      expires: new Date(0),
      maxAge: 0,
    };
    // Copy other options manually
    if (options.path !== undefined) clearOptions.path = options.path;
    if (options.domain !== undefined) clearOptions.domain = options.domain;
    if (options.httpOnly !== undefined) clearOptions.httpOnly = options.httpOnly;
    if (options.secure !== undefined) clearOptions.secure = options.secure;
    if (options.sameSite !== undefined) clearOptions.sameSite = options.sameSite;
    return this.cookie(name, '', clearOptions);
  }

  redirect(url: string, status: number = 302): void {
    if (this.headersSent) return;
    this.statusCode = status;
    const safeUrl = url.replace(/[\r\n]/g, '');
    this.setHeader('Location', safeUrl);
    this.end();
  }

  async sendFile(filePath: string): Promise<void> {
    if (this.headersSent) return;

    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const extension = path.extname(filePath);
      const mime = await this._server.getMimeType(extension);

      const stats = await fs.stat(filePath);
      const data = await fs.readFile(filePath);

      // Add charset for text-based files
      const contentType = this._server.addCharsetIfNeeded(mime);
      this.setHeader('Content-Type', contentType);
      this.setHeader('Content-Length', stats.size);

      // Add security headers for file downloads
      this.setHeader('X-Content-Type-Options', 'nosniff');

      // Add caching headers
      this.setHeader('Last-Modified', stats.mtime.toUTCString());
      this.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year for static files

      this.end(data);
    } catch {
      this.status(404).json({ success: false, error: 'File not found' });
    }
  }

  // Standardized response helpers
  success<T = any>(data: T, message?: string): void {
    const response: any = {
      success: true,
      data,
    };
    if (message !== undefined) {
      response.message = message;
    }
    this.json(response);
  }

  error(error: string, code?: string, message?: string): void {
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
  unauthorized(message: string = 'Authentication required'): void {
    this.statusCode = 401;
    this.json({
      success: false,
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      message,
    });
  }

  forbidden(message: string = 'Insufficient permissions'): void {
    this.statusCode = 403;
    this.json({
      success: false,
      error: 'Forbidden',
      code: 'FORBIDDEN',
      message,
    });
  }

  notFound(resource: string = 'Resource'): void {
    this.statusCode = 404;
    this.json({
      success: false,
      error: 'Not Found',
      code: 'NOT_FOUND',
      message: `${resource} not found`,
    });
  }

  badRequest(message: string = 'Invalid request'): void {
    this.statusCode = 400;
    this.json({
      success: false,
      error: 'Bad Request',
      code: 'BAD_REQUEST',
      message,
    });
  }

  conflict(message: string): void {
    this.statusCode = 409;
    this.json({
      success: false,
      error: 'Conflict',
      code: 'CONFLICT',
      message,
    });
  }

  internalError(message: string = 'Internal server error'): void {
    this.statusCode = 500;
    this.json({
      success: false,
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
      message,
    });
  }

  validationError(errors: Array<{ field: string; message: string; code?: string }>): void {
    this.statusCode = 422;
    this.json({
      success: false,
      error: 'Validation Failed',
      code: 'VALIDATION_ERROR',
      errors,
    });
  }

  rateLimited(retryAfter?: number): void {
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
  created<T = any>(data: T, location?: string): void {
    this.statusCode = 201;
    if (location) {
      this.setHeader('Location', location);
    }
    this.json({
      success: true,
      data,
    });
  }

  noContent(): void {
    this.statusCode = 204;
    this.end();
  }

  paginated<T = any>(data: T[], pagination: { page: number; limit: number; total: number }): void {
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

  // Header management utilities
  override hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  setBulkHeaders(headers: Record<string, string | number>): this {
    if (this.headersSent) {
      // Only enumerate keys for warning if headers were already sent
      const attemptedHeaderKeys = [];
      for (const key in headers) {
        attemptedHeaderKeys.push(key);
      }
      this._server?.logger.warn('Cannot set headers - headers already sent', 'HeaderWarning', {
        attemptedHeaders: attemptedHeaderKeys,
      });
      return this;
    }

    for (const key in headers) {
      const value = headers[key];
      if (value !== undefined) this.setHeader(key, value);
    }
    return this;
  }

  override appendHeader(name: string, value: string | string[]): this {
    if (this.headersSent) {
      this._server?.logger.warn(
        `Cannot append to header '${name}' - headers already sent`,
        'HeaderWarning'
      );
      return this;
    }

    const existing = this.getHeader(name);
    if (existing) {
      const values = Array.isArray(existing) ? existing : [existing.toString()];
      const newValues = Array.isArray(value) ? value : [value];
      this.setHeader(name, [...values, ...newValues]);
    } else {
      this.setHeader(name, value);
    }
    return this;
  }

  // Express-compatible response helpers
  set(
    field: string | Record<string, string | string[] | number>,
    value?: string | string[] | number
  ): this {
    if (this.headersSent) return this;
    if (typeof field === 'string') {
      if (value !== undefined) {
        this.setHeader(field, value as any);
      }
    } else {
      for (const key in field) {
        this.setHeader(key, field[key] as any);
      }
    }
    return this;
  }

  get(field: string): any {
    return this.getHeader(field) as any;
  }

  append(field: string, value: string | string[]): this {
    return this.appendHeader(field, value);
  }

  type(contentType: string): this {
    if (this.headersSent) return this;
    // If no "/" treat as shorthand (e.g. "json" → "application/json")
    let ct = contentType;
    if (ct.indexOf('/') === -1) {
      ct = TYPE_SHORTHANDS[ct.toLowerCase()] || `application/${ct}`;
    }
    this.setHeader('Content-Type', ct);
    return this;
  }

  sendStatus(code: number): void {
    if (this.headersSent) return;
    this.statusCode = code;
    const body = STATUS_MESSAGES[code] || String(code);
    this.setHeader('Content-Type', 'text/plain; charset=utf-8');
    this.end(body);
  }

  location(url: string): this {
    if (this.headersSent) return this;
    const safe = url.replace(/[\r\n]/g, '');
    this.setHeader('Location', safe);
    return this;
  }

  vary(field: string | string[]): this {
    if (this.headersSent) return this;
    const existing = this.getHeader('Vary');
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
    this.setHeader('Vary', existingList.join(', '));
    return this;
  }

  attachment(filename?: string): this {
    if (this.headersSent) return this;
    if (filename) {
      const safeName = filename.replace(/[\r\n"]/g, '');
      this.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      // Set Content-Type from extension if not already set
      if (!this.getHeader('Content-Type')) {
        // fire-and-forget mime lookup; not awaited to keep signature chainable
        void this._server
          .getMimeType(filename.substring(filename.lastIndexOf('.')))
          .then(mime => {
            if (!this.getHeader('Content-Type') && !this.headersSent) {
              this.setHeader('Content-Type', mime);
            }
          })
          .catch(() => {
            // best-effort content-type inference
          });
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
    const matched = ((this as any).req as HttpRequest).accepts(types);
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

  links(links: Record<string, string>): this {
    if (this.headersSent) return this;
    const parts: string[] = [];
    for (const rel in links) {
      parts.push(`<${links[rel]}>; rel="${rel}"`);
    }
    if (parts.length > 0) {
      const existing = this.getHeader('Link');
      const combined = existing ? `${existing}, ${parts.join(', ')}` : parts.join(', ');
      this.setHeader('Link', combined);
    }
    return this;
  }

  // Response state utilities
  canSetHeaders(): boolean {
    return !this.headersSent;
  }

  getResponseState() {
    return {
      headersSent: this.headersSent,
      statusCode: this.statusCode,
      headers: this.getHeaders ? this.getHeaders() : {},
      finished: this.finished || false,
      writable: this.writable,
    };
  }
}

export class MoroHttpServer {
  private server: Server | HttpsServer;
  /** Multipart limits threaded to parseMultipart at the call site. */
  private multipartLimits?: MultipartLimits;
  /** TCP backlog for listen(), when configured. */
  private listenBacklog?: number;
  private routes: RouteEntry[] = [];
  private globalMiddleware: Middleware[] = [];
  /** @internal read by MoroServerResponse prototype methods */
  compressionEnabled = true;
  /** @internal read by MoroServerResponse prototype methods */
  compressionThreshold = 1024;
  /** @internal read by MoroIncomingMessage prototype methods */
  requestTrackingEnabled = true; // Generate request IDs
  /** @internal read by MoroServerResponse prototype methods */
  logger = createFrameworkLogger('HttpServer');
  private hookManager: any;
  private requestCounter = 0;
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;
  private requestDecorations: Record<string, any> = {};
  private responseDecorations: Record<string, any> = {};

  // Per-server request/response subclasses; their prototype carries the
  // `_server` back-reference plus user decorations (applied once, not per request)
  private RequestClass!: typeof MoroIncomingMessage;
  private ResponseClass!: typeof MoroServerResponse;

  // Direct router dispatch slot - runs after global middleware without the
  // per-middleware promise machinery (set from Moro.listen via setRouterHandler)
  private routerHandler?: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>;

  // Body size limits - defaults overridden by config in constructor
  private maxBodySize: number = 10 * 1024 * 1024; // Default 10MB (overridden by server.bodySizeLimit config)
  private maxUploadSize: number = 100 * 1024 * 1024; // Default 100MB for file uploads (future: configurable)

  // Use shared object pool manager
  private poolManager = ObjectPoolManager.getInstance();

  // Interned method strings for fast reference equality comparison
  private static readonly METHOD_POST = 'POST';
  private static readonly METHOD_PUT = 'PUT';
  private static readonly METHOD_PATCH = 'PATCH';
  private static readonly METHOD_GET = 'GET';
  private static readonly METHOD_DELETE = 'DELETE';
  private static readonly METHOD_HEAD = 'HEAD';
  private static readonly METHOD_OPTIONS = 'OPTIONS';

  // Pre-compiled response templates for common responses
  private static readonly RESPONSE_TEMPLATES = {
    notFound: Buffer.from('{"success":false,"error":"Not found"}'),
    unauthorized: Buffer.from('{"success":false,"error":"Unauthorized"}'),
    forbidden: Buffer.from('{"success":false,"error":"Forbidden"}'),
    internalError: Buffer.from('{"success":false,"error":"Internal server error"}'),
    methodNotAllowed: Buffer.from('{"success":false,"error":"Method not allowed"}'),
    rateLimited: Buffer.from('{"success":false,"error":"Rate limit exceeded"}'),
  };

  constructor(options?: {
    maxBodySize?: number;
    maxUploadSize?: number;
    /** node-style TLS material (from the unified ssl normalizer). When present
     *  the server is created via https.createServer. */
    ssl?: {
      key: string | Buffer;
      cert: string | Buffer;
      ca?: Array<string | Buffer>;
      passphrase?: string;
      minVersion?: string;
      requestCert?: boolean;
      rejectUnauthorized?: boolean;
    };
    limits?: HttpRuntimeLimits;
  }) {
    // Per-instance subclasses so prototype methods can reach this server's
    // config (logger, compression) with zero per-request allocation.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const boundServer = this;
    class BoundRequest extends MoroIncomingMessage {}
    class BoundResponse extends MoroServerResponse {}
    BoundRequest.prototype._server = boundServer;
    BoundResponse.prototype._server = boundServer;
    this.RequestClass = BoundRequest;
    this.ResponseClass = BoundResponse;

    const limits = options?.limits;
    // maxHeaderSize is a createServer option (not a mutable property), so it
    // must be passed here.
    const serverOpts: any = {
      IncomingMessage: BoundRequest as any,
      ServerResponse: BoundResponse as any,
      ...(limits?.maxHeaderSize && { maxHeaderSize: limits.maxHeaderSize }),
    };

    if (options?.ssl) {
      // In-process HTTPS. The https ServerOptions extends the http one, so the
      // IncomingMessage/ServerResponse subclass injection carries over.
      this.server = createHttpsServer(
        { ...serverOpts, ...options.ssl },
        this.handleRequest.bind(this) as any
      );
      this.logger.info('HTTPS server created (in-process TLS)', 'HttpServer');
    } else {
      this.server = createServer(serverOpts, this.handleRequest.bind(this) as any);
    }

    // Configure body size limits from options
    if (options?.maxBodySize) {
      this.maxBodySize = options.maxBodySize;
    }
    if (options?.maxUploadSize) {
      this.maxUploadSize = options.maxUploadSize;
    }
    if (limits?.multipart) this.multipartLimits = limits.multipart;

    // Timeouts: the previous hardcodes (keepAlive 5000, headers 6000) become
    // the documented defaults; a configured value overrides them. Socket idle
    // timeout stays 0 (disabled) unless set - a non-zero value arms a
    // per-request timer that shows up in CPU profiles under load.
    const t = limits?.timeouts ?? {};
    this.server.keepAliveTimeout = t.keepAlive ?? 5000;
    this.server.headersTimeout = t.headers ?? 6000;
    this.server.timeout = t.idle ?? 0;
    if (t.request) this.server.requestTimeout = t.request;
    if (limits?.maxConnections && limits.maxConnections > 0) {
      this.server.maxConnections = limits.maxConnections;
    }
    if (limits?.maxHeaders) this.server.maxHeadersCount = limits.maxHeaders;
    if (limits?.backlog !== undefined) this.listenBacklog = limits.backlog;
  }

  // Direct router dispatch - called after global middleware, before the legacy
  // route table. Returning true (or a promise of true) means the request was handled.
  setRouterHandler(fn: (req: HttpRequest, res: HttpResponse) => boolean | Promise<boolean>): void {
    this.routerHandler = fn;
  }

  // Configure server for maximum performance (can disable all overhead)
  configurePerformance(
    config: {
      compression?: { enabled: boolean; threshold?: number };
      minimal?: boolean;
    } = {}
  ) {
    if (config.compression !== undefined) {
      this.compressionEnabled = config.compression.enabled;
      if (config.compression.threshold !== undefined) {
        this.compressionThreshold = config.compression.threshold;
      }
    }

    // Minimal mode - disable ALL overhead for pure speed
    if (config.minimal) {
      this.compressionEnabled = false;
      this.compressionThreshold = Infinity; // Never compress
    }
  }

  // Configure request tracking (ID generation)
  setRequestTracking(enabled: boolean): void {
    this.requestTrackingEnabled = enabled;
  }

  // Register a global error handler (called from Moro.setErrorHandler)
  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): void {
    this.errorHandler = fn;
  }

  // Apply request/response decoration maps (called from Moro.decorateRequest/Reply).
  // Decorations are installed on the per-server prototypes once, so requests pay
  // nothing for them; per-request writes to the same key simply shadow the prototype.
  setRequestDecorations(decorations: Record<string, any>): void {
    this.requestDecorations = decorations;
    for (const key in decorations) {
      Object.defineProperty(this.RequestClass.prototype, key, {
        value: decorations[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  setResponseDecorations(decorations: Record<string, any>): void {
    this.responseDecorations = decorations;
    for (const key in decorations) {
      Object.defineProperty(this.ResponseClass.prototype, key, {
        value: decorations[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
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

  // Set hooks manager for request processing
  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
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
      // Static route - O(1) lookup
      const staticKey = `${method}:${path}`;
      this.staticRoutes.set(staticKey, route);
    } else {
      // Dynamic route - organize by segment count for faster matching
      this.dynamicRoutes.push(route);

      const segmentCount = PathMatcher.countSegments(path);

      if (!this.routesBySegmentCount.has(segmentCount)) {
        this.routesBySegmentCount.set(segmentCount, []);
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.routesBySegmentCount.get(segmentCount)!.push(route);
    }
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    // Use shared PathMatcher for consistent path compilation
    const compiled = PathMatcher.compile(path);
    return {
      pattern: compiled.pattern || new RegExp(`^${path.replace(/\//g, '\\/')}$`),
      paramNames: compiled.paramNames,
    };
  }

  // Request entry point. Deliberately NOT an async function: the common case
  // (no body, no hooks, no global middleware, sync route handler) completes
  // fully synchronously with zero promise allocations and zero microtask
  // hops. Anything that genuinely needs to await routes through
  // handleRequestSlow.
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // req/res arrive as the per-server subclasses (MoroIncomingMessage /
    // MoroServerResponse) - all helpers are already on their prototypes.
    const httpReq = req as unknown as HttpRequest & MoroIncomingMessage;
    const httpRes = res as unknown as HttpResponse & MoroServerResponse;

    // URL split - query string parsing is lazy (MoroIncomingMessage#query getter)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const urlString = req.url!;
    const queryIndex = urlString.indexOf('?');

    if (queryIndex === -1) {
      httpReq.path = urlString;
    } else {
      httpReq.path = urlString.substring(0, queryIndex);
      httpReq._queryString = urlString.substring(queryIndex + 1);
    }

    // Intern method string for fast reference equality comparison (50-100% faster)
    switch (req.method) {
      case 'POST':
        httpReq.method = MoroHttpServer.METHOD_POST;
        break;
      case 'PUT':
        httpReq.method = MoroHttpServer.METHOD_PUT;
        break;
      case 'PATCH':
        httpReq.method = MoroHttpServer.METHOD_PATCH;
        break;
      case 'GET':
        httpReq.method = MoroHttpServer.METHOD_GET;
        break;
      case 'DELETE':
        httpReq.method = MoroHttpServer.METHOD_DELETE;
        break;
      case 'HEAD':
        httpReq.method = MoroHttpServer.METHOD_HEAD;
        break;
      case 'OPTIONS':
        httpReq.method = MoroHttpServer.METHOD_OPTIONS;
        break;
    }

    const needsBody =
      httpReq.method === MoroHttpServer.METHOD_POST ||
      httpReq.method === MoroHttpServer.METHOD_PUT ||
      httpReq.method === MoroHttpServer.METHOD_PATCH;
    const hookManager = this.hookManager;
    const hasHooks = !!(
      hookManager &&
      (hookManager.hasHooks === undefined || hookManager.hasHooks('request'))
    );

    if (needsBody || hasHooks || this.globalMiddleware.length > 0) {
      // Slow path: real awaits ahead (body parse / hooks / middleware).
      // Errors are fully handled inside - the returned promise never rejects.
      void this.handleRequestSlow(httpReq, httpRes, req, needsBody, hasHooks);
      return;
    }

    // FAST PATH - no promises unless the route handler itself is async
    try {
      const routerHandler = this.routerHandler;
      if (routerHandler) {
        const handled = routerHandler(httpReq, httpRes);
        if (handled) {
          if (typeof (handled as any).then === 'function') {
            (handled as Promise<boolean>).then(
              wasHandled => {
                if (!wasHandled && !httpRes.headersSent) {
                  try {
                    this.dispatchLegacyRoute(httpReq, httpRes, req);
                  } catch (error) {
                    void this.onRequestError(error, httpReq, httpRes, req);
                  }
                }
              },
              error => void this.onRequestError(error, httpReq, httpRes, req)
            );
          }
          return;
        }
        if (httpRes.headersSent) return;
      }

      this.dispatchLegacyRoute(httpReq, httpRes, req);
    } catch (error) {
      void this.onRequestError(error, httpReq, httpRes, req);
    }
  }

  // Full async pipeline for requests that need it: bodied methods, hook
  // consumers, and apps with global middleware.
  private async handleRequestSlow(
    httpReq: HttpRequest & MoroIncomingMessage,
    httpRes: HttpResponse & MoroServerResponse,
    req: IncomingMessage,
    needsBody: boolean,
    hasHooks: boolean
  ): Promise<void> {
    try {
      if (needsBody) {
        httpReq.body = await this.parseBody(req);
      }

      if (hasHooks) {
        await this.hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // executeMiddleware returns undefined when the whole chain completed
      // synchronously, so a sync chain costs zero promise allocations.
      if (this.globalMiddleware.length > 0) {
        const mwResult = this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
        if (mwResult) await mwResult;
      }

      // If middleware handled the request, don't continue
      if (httpRes.headersSent) {
        return;
      }

      // Unified router direct dispatch - no middleware-chain promise wrapper
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

      this.dispatchLegacyRoute(httpReq, httpRes, req);
    } catch (error) {
      await this.onRequestError(error, httpReq, httpRes, req);
    }
  }

  // Legacy direct-route table dispatch + 404 fallback. Synchronous; async
  // route middleware/handlers are continued via promise callbacks wired to
  // onRequestError so the sync fast path stays promise-free.
  private dispatchLegacyRoute(
    httpReq: HttpRequest & MoroIncomingMessage,
    httpRes: HttpResponse & MoroServerResponse,
    req: IncomingMessage
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const route = this.findRoute(req.method!, httpReq.path);
    if (!route) {
      // 404 response with pre-compiled buffer
      httpRes.statusCode = 404;
      httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      httpRes.setHeader('Content-Length', MoroHttpServer.RESPONSE_TEMPLATES.notFound.length);
      httpRes.end(MoroHttpServer.RESPONSE_TEMPLATES.notFound);
      return;
    }

    // Extract path parameters
    const matches = httpReq.path.match(route.pattern);
    if (matches) {
      const params: Record<string, string> = {};
      const paramNames = route.paramNames;
      const paramNamesLen = paramNames.length;
      for (let i = 0; i < paramNamesLen; i++) {
        const paramName = paramNames[i];
        const value = matches[i + 1];
        if (paramName !== undefined && value !== undefined) {
          params[paramName] = value;
        }
      }
      httpReq.params = params;
    }

    const runHandler = () => {
      // Execute handler - Don't await sync handlers
      const handlerResult = route.handler(httpReq, httpRes);
      if (handlerResult && typeof handlerResult.then === 'function') {
        (handlerResult as Promise<void>).catch(
          error => void this.onRequestError(error, httpReq, httpRes, req)
        );
      }
    };

    // Execute middleware chain - EARLY EXIT if no route middleware
    if (route.middleware.length > 0) {
      const mwResult = this.executeMiddleware(route.middleware, httpReq, httpRes);
      if (mwResult) {
        mwResult.then(runHandler, error => void this.onRequestError(error, httpReq, httpRes, req));
        return;
      }
    }

    runHandler();
  }

  // Shared error handling for all request paths (sync throw, slow-path catch,
  // and promise rejections from async handlers/middleware). Never throws.
  private async onRequestError(
    error: unknown,
    httpReq: HttpRequest & MoroIncomingMessage,
    httpRes: HttpResponse & MoroServerResponse,
    req: IncomingMessage
  ): Promise<void> {
    try {
      // Debug: Log the actual error and where it came from
      this.logger.debug('Request error details', 'RequestHandler', {
        errorType: typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : 'No stack trace',
        requestPath: req.url,
        requestMethod: req.method,
      });

      // Payload-too-large from parseBody: respond 413 (matches the old bodySize
      // middleware semantics, now enforced in-server)
      if ((error as any)?.statusCode === 413 && !httpRes.headersSent) {
        httpRes.statusCode = 413;
        httpRes.json({
          success: false,
          error: 'Request entity too large',
        });
        return;
      }

      this.logger.error('Request error', 'RequestHandler', {
        error: error instanceof Error ? error.message : String(error),
        requestId: httpReq.requestId,
        method: req.method,
        path: req.url,
      });

      // User-registered global error handler takes precedence over the default 500.
      if (this.errorHandler && !httpRes.headersSent) {
        try {
          const handlerResult = this.errorHandler(error, httpReq, httpRes);
          if (handlerResult && typeof (handlerResult as any).then === 'function') {
            await handlerResult;
          }
          if (httpRes.headersSent) return;
        } catch (handlerErr) {
          this.logger.error('Error handler itself threw', 'RequestHandler', {
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        }
      }

      if (!httpRes.headersSent) {
        // A malformed body is a client error: default to 400 (parity with the
        // engine/uWS transports), not the generic 500.
        const isBadRequest = (error as any)?.statusCode === 400;
        const defaultStatus = isBadRequest ? 400 : 500;
        const defaultError = isBadRequest ? 'Invalid request body' : 'Internal server error';
        // Ensure response is properly enhanced before using custom methods
        if (typeof httpRes.status === 'function' && typeof httpRes.json === 'function') {
          httpRes.status(defaultStatus).json({
            success: false,
            error: defaultError,
            requestId: httpReq.requestId,
          });
        } else {
          // Defensive fallback - check each method individually
          if (typeof httpRes.setHeader === 'function') {
            httpRes.statusCode = defaultStatus;
            httpRes.setHeader('Content-Type', 'application/json');
          } else {
            // Even setHeader doesn't exist - object is completely wrong
            this.logger.error('Response object is not a proper ServerResponse', 'RequestHandler', {
              responseType: typeof httpRes,
              responseKeys: Object.keys(httpRes),
            });
          }

          if (typeof httpRes.end === 'function') {
            httpRes.end(
              JSON.stringify({
                success: false,
                error: defaultError,
                requestId: httpReq.requestId,
              })
            );
          } else {
            this.logger.error(
              'Cannot send error response - end() method missing',
              'RequestHandler'
            );
          }
        }
      }
    } catch (fatalError) {
      // Error handling itself failed (e.g. the connection died mid-response) -
      // never let this escape as an unhandled rejection
      this.logger.error('Failed while handling request error', 'RequestHandler', {
        error: fatalError instanceof Error ? fatalError.message : String(fatalError),
      });
    }
  }

  // Force cleanup of all pooled objects
  private forceCleanupPools(): void {
    // Use shared pool manager cleanup
    this.poolManager.clearAll();

    // Force garbage collection if available
    if (globalThis?.gc) {
      globalThis.gc();
    }
  }

  private acquireBuffer(size: number): Buffer {
    return this.poolManager.acquireBuffer(size);
  }

  private releaseBuffer(buffer: Buffer): void {
    this.poolManager.releaseBuffer(buffer);
  }

  private streamLargeResponse(res: any, data: any): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Stream large JSON responses to prevent memory issues
    if (Array.isArray(data) && data.length > 100) {
      // Stream large arrays element by element
      res.write('[');

      // Stream each array element
      let first = true;
      for (const item of data) {
        if (!first) res.write(',');
        res.write(JSON.stringify(item));
        first = false;
      }

      // Write closing bracket and end
      res.end(']');
    } else if (typeof data === 'object' && data !== null && Object.keys(data).length > 50) {
      // For large objects, stream key-value pairs
      res.write('{');
      const keys = Object.keys(data);
      let first = true;

      for (const key of keys) {
        if (!first) res.write(',');
        // Properly escape the key using JSON.stringify
        res.write(`${JSON.stringify(key)}:${JSON.stringify(data[key])}`);
        first = false;
      }

      res.end('}');
    } else {
      // For smaller data, still avoid the old chunking approach
      const jsonString = JSON.stringify(data);
      res.end(jsonString);
    }
  }

  private normalizePath(path: string): string {
    // Check cache first
    if (this.pathNormalizationCache.has(path)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.pathNormalizationCache.get(path)!;
    }

    // Normalization: remove trailing slash (except root), decode once
    let normalized = path;
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Cache result (limit cache size)
    if (this.pathNormalizationCache.size < 200) {
      this.pathNormalizationCache.set(path, normalized);
    }

    return normalized;
  }

  /** @internal called by MoroServerResponse prototype methods */
  async getMimeType(ext: string): Promise<string> {
    const mimeTypes: Record<string, string> = {
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

    return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
  }

  /** @internal called by MoroServerResponse prototype methods */
  addCharsetIfNeeded(mimeType: string): string {
    // Add charset for text-based content types - optimized with early exit
    // Check most common cases first
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

  private async parseBody(req: IncomingMessage): Promise<any> {
    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0');

    // Use different limits based on content type
    // Multipart (file uploads) need much larger limits than JSON/form data
    const isMultipart = contentType.includes('multipart/form-data');
    const maxSize = isMultipart
      ? this.maxUploadSize // Configurable file upload limit (default 100MB)
      : this.maxBodySize; // Configurable body size limit (default 10MB, from server.bodySizeLimit config)

    // Early rejection from the declared Content-Length - nothing is read off the wire
    if (contentLength > maxSize) {
      const error: any = new Error('Request entity too large');
      error.statusCode = 413;
      error.limit = maxSize;
      error.received = contentLength;
      return Promise.reject(error);
    }

    // Buffer every body up to maxSize and parse it into its real shape. The
    // incremental limit check below already bounds memory, and every other
    // backend (uWS, engine) returns the parsed body here - previously bodies
    // between maxSize/2 and maxSize resolved to a { type, parser } descriptor
    // object instead, so handlers/validation on the Node backend silently saw
    // a bogus shape for the exact same request that parsed normally elsewhere.
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLength = 0;

      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          const errorMessage = isMultipart
            ? `File upload too large. Maximum ${Math.floor(maxSize / (1024 * 1024))}MB allowed.`
            : 'Request body too large';
          const error: any = new Error(errorMessage);
          error.statusCode = 413;
          error.limit = maxSize;
          reject(error);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          // Single-chunk fast path (most JSON bodies arrive in one chunk);
          // otherwise concat with the known total length to avoid a re-scan
          const firstChunk = chunks[0];
          const body =
            chunks.length === 1 && firstChunk !== undefined
              ? firstChunk
              : Buffer.concat(chunks, totalLength);

          if (contentType.includes('application/json')) {
            // Empty JSON body -> null (parity with the engine/uWS servers, and
            // avoids JSON.parse('') throwing and 500ing an empty POST).
            resolve(totalLength === 0 ? null : JSON.parse(body.toString()));
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            resolve(this.parseUrlEncoded(body.toString()));
          } else if (contentType.includes('multipart/form-data')) {
            resolve(this.parseMultipart(body, contentType));
          } else {
            resolve(body.toString());
          }
        } catch (error) {
          // A malformed body is a client error (400), not a server error (500).
          // Tag it so the request-error path answers 400, matching the engine
          // and uWS transports.
          if (error instanceof Error && (error as any).statusCode === undefined) {
            (error as any).statusCode = 400;
          }
          reject(error);
        }
      });

      req.on('error', reject);
    });
  }

  private parseMultipart(
    buffer: Buffer,
    contentType: string
  ): { fields: Record<string, string>; files: Record<string, any> } {
    // Shared implementation - the native engine server parses uploads with
    // the exact same code so both transports agree on body/files shape
    return parseMultipartBuffer(buffer, contentType, this.multipartLimits);
  }

  private parseUrlEncoded(body: string): Record<string, string> {
    const params = new URLSearchParams(body);
    const result: Record<string, string> = {};
    for (const [key, value] of params) {
      result[key] = value;
    }
    return result;
  }

  // Legacy methods for backward compatibility - the hot path now parses query
  // strings lazily via the MoroIncomingMessage#query getter (no pooling: a fresh
  // object literal is cheaper than pool bookkeeping)
  private parseQueryString(queryString: string): Record<string, string> {
    return parseQueryString(queryString);
  }

  private parseQueryStringPooled(queryString: string): Record<string, string> {
    return parseQueryString(queryString);
  }

  // Advanced route optimization: cache + static routes + segment grouping
  private routeCache = new Map<string, RouteEntry | null>();
  private staticRoutes = new Map<string, RouteEntry>();
  private dynamicRoutes: RouteEntry[] = [];
  private routesBySegmentCount = new Map<number, RouteEntry[]>();
  private pathNormalizationCache = new Map<string, string>();

  // CPU cache-friendly optimizations
  private routeHitCount = new Map<string, number>(); // Track route popularity for cache optimization
  private static readonly HOT_ROUTE_THRESHOLD = 100; // Routes accessed 100+ times get hot path treatment

  private findRoute(method: string, path: string): RouteEntry | null {
    // Skip normalization and hit tracking for cached routes
    const cacheKey = `${method}:${path}`;

    // Check cache first (hot path optimization) - BEFORE any other work
    if (this.routeCache.has(cacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(cacheKey)!;
    }

    // Normalize path for consistent matching (only if not cached)
    const normalizedPath = this.normalizePath(path);
    const normalizedCacheKey = normalizedPath !== path ? `${method}:${normalizedPath}` : cacheKey;

    // Check cache again with normalized path
    if (normalizedPath !== path && this.routeCache.has(normalizedCacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(normalizedCacheKey)!;
    }

    // O(1) static route lookup
    const staticRoute = this.staticRoutes.get(normalizedCacheKey);
    if (staticRoute) {
      this.routeCache.set(normalizedCacheKey, staticRoute);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, staticRoute);
      }
      return staticRoute;
    }

    // Dynamic route matching by segment count
    let route: RouteEntry | null = null;
    const dynamicRoutesLen = this.dynamicRoutes.length;
    if (dynamicRoutesLen > 0) {
      // Use shared utility for DRY principle
      const segmentCount = PathMatcher.countSegments(normalizedPath);

      const candidateRoutes = this.routesBySegmentCount.get(segmentCount) || this.dynamicRoutes;
      const candidateLen = candidateRoutes.length;

      // Only test routes with matching method and segment count
      for (let i = 0; i < candidateLen; i++) {
        const candidateRoute = candidateRoutes[i];
        if (candidateRoute === undefined) continue;
        if (candidateRoute.method === method && candidateRoute.pattern.test(normalizedPath)) {
          route = candidateRoute;
          break;
        }
      }
    }

    // Cache result (limit cache size to prevent memory leaks)
    if (this.routeCache.size < 500) {
      this.routeCache.set(normalizedCacheKey, route);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, route);
      }
    }

    return route;
  }

  // Middleware execution with Express-compatible error propagation.
  // Supports: 3-arg (req, res, next), 4-arg (err, req, res, next) error middlewares,
  // and next(err) to skip forward to the next error middleware.
  //
  // Sync-aware dispatch: middleware that calls next() synchronously (or throws
  // synchronously) advances the chain in a plain loop with ZERO promise
  // allocations. A promise is only created when a middleware actually completes
  // asynchronously. Returns undefined when the whole chain ran synchronously.
  private executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    return this.dispatchMiddleware(middleware, req, res, 0, undefined);
  }

  private dispatchMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse,
    startIndex: number,
    initialError: any
  ): void | Promise<void> {
    const len = middleware.length;
    let activeError: any = initialError;
    let i = startIndex;

    while (i < len) {
      if (res.headersSent) return;

      const mw = middleware[i] as any;
      i++;
      const isErrorHandler = mw.length >= 4;

      // Non-error middleware is skipped while an error is active; error middleware
      // is skipped while no error is active. Matches Express semantics.
      if (activeError !== undefined && !isErrorHandler) continue;
      if (activeError === undefined && isErrorHandler) continue;

      let settled = false;
      let settledError: any = undefined;
      let asyncResolve: ((err: any) => void) | undefined;

      const next = (err?: any) => {
        if (settled) return;
        settled = true;
        settledError = err;
        if (asyncResolve) asyncResolve(err);
      };

      let result: any;
      try {
        result = isErrorHandler ? mw(activeError, req, res, next) : mw(req, res, next);
      } catch (err) {
        if (!settled) {
          settled = true;
          settledError = err;
        }
      }

      const isThenable = result && typeof result.then === 'function';

      if (settled) {
        // Completed synchronously (next() called sync, or threw sync).
        // Matches the old behavior: a still-pending returned promise no longer
        // gates the chain once next() has been called; swallow late rejections.
        if (isThenable) {
          (result as Promise<void>).then(undefined, () => {});
        }
        activeError = settledError;
        continue;
      }

      if (!isThenable) {
        // Sync-looking middleware that neither called next() nor returned a
        // promise: it will call next() later (e.g. from an event callback).
        // Fall back to a promise for the remainder of the chain.
        const resumeIndex = i;
        return new Promise<any>(resolve => {
          asyncResolve = resolve;
        }).then(err => this.dispatchMiddleware(middleware, req, res, resumeIndex, err));
      }

      // Async middleware: completion is next() OR promise settle, whichever
      // happens first (same semantics as the previous implementation).
      const resumeIndex = i;
      return new Promise<any>(resolve => {
        asyncResolve = resolve;
        (result as Promise<void>).then(
          () => {
            if (!settled) next();
          },
          (err: any) => {
            if (!settled) next(err);
          }
        );
      }).then(err => this.dispatchMiddleware(middleware, req, res, resumeIndex, err));
    }

    // If an error is still unhandled after the chain, re-throw so the top-level
    // catch in handleRequest can invoke the registered errorHandler / default 500.
    if (activeError !== undefined) {
      throw activeError;
    }
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, host?: string | (() => void), callback?: () => void): void {
    // Handle overloaded parameters (port, callback) or (port, host, callback)
    if (typeof host === 'function') {
      callback = host;
      host = undefined;
    }

    const backlog = this.listenBacklog;
    if (host && backlog) {
      this.server.listen(port, host, backlog, callback);
    } else if (host) {
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

  // Public method to force cleanup
  forceCleanup(): void {
    this.forceCleanupPools();
  }

  getServer(): Server {
    return this.server;
  }

  // Performance statistics
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
