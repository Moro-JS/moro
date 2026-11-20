// HTTP Server Types
import type { IncomingMessage, ServerResponse } from 'http';

export interface HttpRequest extends IncomingMessage {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  /**
   * The request body exactly as received, before any parsing (JSON included),
   * or null when the request carried none. What webhook signature checks
   * (HMAC over the wire bytes) need; bounded by the same body size limits.
   */
  readonly rawBody: Buffer | null;
  path: string;
  headers: Record<string, string>;
  ip: string;
  requestId: string;
  cookies?: Record<string, string>;
  /** Signed cookies whose signature verified; requires a cookie middleware secret. */
  signedCookies?: Record<string, string>;
  files?: Record<string, any>;

  // Per-request typed context (pass data between middlewares without monkey-patching req)
  context: Record<string, any>;

  // Express-compatible helpers
  get(name: string): string | undefined;
  header(name: string): string | undefined;
  is(type: string): boolean;
  accepts(types?: string | string[]): string | false;
  acceptsLanguages(langs?: string | string[]): string | false;
  hostname: string;
  protocol: string;
  secure: boolean;
  xhr: boolean;
  originalUrl: string;
  ips: string[];
  subdomains: string[];

  [key: string]: any;
}

export interface CookieOptions {
  /**
   * Lifetime in milliseconds, as in Express (24 hours is `24 * 60 * 60 * 1000`).
   * Sent as whole seconds of `Max-Age`; `null` sends no `Max-Age`.
   */
  maxAge?: number | null;
  expires?: Date;
  httpOnly?: boolean;
  /**
   * Whether the cookie is `Secure`. Left out, it follows the connection: the
   * cookie is `Secure` when the request arrived over TLS (a TLS connection to
   * this server, or https as reported by a proxy named in `server.trustProxy`),
   * and is not when it arrived over plain http.
   */
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  domain?: string;
  path?: string;
  // Security options
  signed?: boolean; // Sign the value; throws unless the cookie middleware has a secret
  critical?: boolean; // Mark as critical for security (throws on late set)
  throwOnLateSet?: boolean; // Force throw if headers already sent
}

/** Options of `res.sendFile()` and `res.download()`. */
export interface SendFileOptions {
  /**
   * Cache lifetime in seconds (the unit `staticFiles` uses): sends
   * `Cache-Control: public, max-age=<maxAge>`. Left unset, the helpers send
   * no `Cache-Control` of their own.
   */
  maxAge?: number;
  /** Adds `immutable` to the `Cache-Control` that `maxAge` produces. */
  immutable?: boolean;
  /**
   * A string is sent as the `Cache-Control` value as it is (for example
   * `'private, max-age=600'`). `true` sends `public, max-age=<maxAge or 0>`;
   * `false` sends none, whatever `maxAge` says.
   */
  cacheControl?: boolean | string;
  /**
   * Directory the path is resolved against and confined to: a path that
   * leads outside it (`../`, an absolute path, a symlink) is answered 404.
   */
  root?: string;
  /**
   * What to do with a path that has a segment starting with a dot below
   * `root` (or, without a `root`, a file whose own name starts with one):
   * `'ignore'` answers 404, `'deny'` 403, `'allow'` serves it. `.well-known`
   * is never treated as hidden. Default: `'ignore'` when `root` is set,
   * `'allow'` otherwise.
   */
  dotfiles?: 'allow' | 'deny' | 'ignore';
}

export interface ResponseState {
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, any>;
  finished: boolean;
  writable: boolean;
}

export interface MoroResponseMethods {
  json(data: any): void;
  status(code: number): HttpResponse;
  send(data: string | Buffer): void;
  cookie(name: string, value: string, options?: CookieOptions): HttpResponse;
  clearCookie(name: string, options?: CookieOptions): HttpResponse;
  redirect(url: string, status?: number): void;
  /**
   * Send a file. No `Cache-Control` is sent unless `options` asks for one
   * (`maxAge` in seconds, `immutable`, `cacheControl`); `root` confines the
   * path to a directory. Never rejects: a missing file is answered 404.
   */
  sendFile(filePath: string, options?: SendFileOptions): Promise<void>;
  render?(template: string, data?: any): Promise<void>;
  /**
   * Send a file, honouring `Range` and `If-Range`. Installed on the response
   * by `middleware.range()`.
   *
   * The optional second argument is either `{ root }`, which resolves
   * `filePath` against that directory and answers 404 for anything that leads
   * outside it, or an `fs.Stats` for the file, which only saves a stat call.
   */
  sendRange(
    filePath: string,
    statsOrOptions?:
      { isFile(): boolean } | { root?: string; dotfiles?: 'allow' | 'deny' | 'ignore' }
  ): Promise<void>;

  /**
   * HTTP/2 only (absent on the other servers). `push()` starts a server push
   * for `path` and returns the push stream, or `null` when the client has
   * push disabled or the response has already started. `setPriority()` sets
   * the stream's priority.
   */
  push?(
    path: string,
    options?: { headers?: Record<string, string | number | string[]>; priority?: number }
  ): any;
  setPriority?(options?: { parent?: number; weight?: number; exclusive?: boolean }): HttpResponse;

  /**
   * Server-Sent Events helpers, installed on the response by
   * `middleware.sse()` (absent without it). `sse()` opens the event stream
   * (status 200, `Content-Type: text/event-stream`) and returns its
   * connection; the three senders open it on first use. Nothing is sent
   * until the handler calls one of them.
   */
  sse?(): {
    sendEvent(data: any, event?: string, id?: string): void;
    sendComment(comment: string): void;
    sendRetry(ms: number): void;
    close(): void;
  };
  sendEvent?(data: any, event?: string, id?: string): void;
  sendComment?(comment: string): void;
  sendRetry?(ms: number): void;

  /**
   * CDN helpers, installed on the response by `middleware.cdn()` (absent
   * without it). `purgeCDN()` with no argument purges the current path.
   */
  purgeCDN?(urls?: string[]): Promise<void>;
  prefetchCDN?(urls: string[]): Promise<void>;
  getCDNStats?(): Promise<any>;

  // Per-response typed state bag (Express-compatible res.locals)
  locals: Record<string, any>;

  // Express-compatible response helpers
  set(
    field: string | Record<string, string | string[] | number>,
    value?: string | string[] | number
  ): HttpResponse;
  get(field: string): string | number | string[] | undefined;
  append(field: string, value: string | string[]): HttpResponse;
  type(contentType: string): HttpResponse;
  sendStatus(code: number): void;
  location(url: string): HttpResponse;
  vary(field: string | string[]): HttpResponse;
  links(links: Record<string, string>): HttpResponse;
  attachment(filename?: string): HttpResponse;
  /**
   * `attachment()` then `sendFile()`: the display name goes into
   * `Content-Disposition`, the `Content-Type` comes from the file itself.
   * `options` are `sendFile()`'s, as the second or the third argument.
   */
  download(
    filePath: string,
    filename?: string | SendFileOptions,
    options?: SendFileOptions
  ): Promise<void>;
  format(handlers: Record<string, () => any | Promise<any>>): void;

  // Header management utilities
  hasHeader(name: string): boolean;
  setBulkHeaders(headers: Record<string, string | number>): HttpResponse;
  appendHeader(name: string, value: string | string[]): HttpResponse;

  // Response state utilities
  canSetHeaders(): boolean;
  getResponseState(): ResponseState;

  // Standardized response helpers
  success<T = any>(data: T, message?: string): void;
  error(error: string, code?: string, message?: string): void;

  // Common HTTP error helpers (automatically set status code)
  unauthorized(message?: string): void;
  forbidden(message?: string): void;
  notFound(resource?: string): void;
  badRequest(message?: string): void;
  conflict(message: string): void;
  internalError(message?: string): void;
  validationError(errors: Array<{ field: string; message: string; code?: string }>): void;
  rateLimited(retryAfter?: number): void;

  // Common success patterns
  created<T = any>(data: T, location?: string): void;
  noContent(): void;
  paginated<T = any>(
    data: T[],
    pagination: {
      page: number;
      limit: number;
      total: number;
    }
  ): void;
}

export type HttpResponse = ServerResponse & MoroResponseMethods;

export type HttpHandler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: (err?: unknown) => void
) => Promise<void> | void;
export type MiddlewareFunction = (
  req: HttpRequest,
  res: HttpResponse,
  next: (err?: unknown) => void
) => void | Promise<void>;

// Internal router types
export interface RouteEntry {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HttpHandler;
  middleware: Middleware[];
}

export interface RouteDefinition {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HttpHandler;
  middleware: Middleware[];
}
