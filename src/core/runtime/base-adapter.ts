// Base runtime adapter with common functionality
import { RuntimeAdapter, RuntimeType, RuntimeHttpResponse } from '../../types/runtime.js';
import { HttpRequest, HttpResponse, Middleware } from '../../types/http.js';
import { createFrameworkLogger } from '../logger/index.js';
import { serializeCookie, clearCookieOptions } from '../http/http-server.js';
import { dispatchMiddleware, WAIT_UNLESS_ANSWERED } from '../http/utils/middleware-dispatch.js';
import { parseRawQueryString } from '../http/utils/query-parser.js';

// req.cookies is parsed by the Node server's rule on every runtime
export { parseCookieHeader } from '../http/http-server.js';
import { randomBytes } from 'crypto';

/** Logger for the notices these runtimes give once per process */
export const runtimeLogger = createFrameworkLogger('Runtime');

const SET_COOKIE = 'Set-Cookie';

function isSetCookie(name: string): boolean {
  return name.length === 10 && name.toLowerCase() === 'set-cookie';
}

// CR and LF end a header line, so a value never carries them: whatever writes
// the header to the wire would split it in two (Lambda), or the platform's
// Headers would refuse the value (Edge, Workers).
function headerValue(value: string): string {
  return value.indexOf('\n') === -1 && value.indexOf('\r') === -1
    ? value
    : value.replace(/[\r\n]/g, '');
}

// res.cookie(..., { signed: true }): cookies are signed by the cookie
// middleware, which replaces res.cookie() with its own. Reaching this one
// means no such middleware ran for the request, so the value goes out as
// given. Said once per process, on the first such call, as the Node server does.
let unsignedCookieWarned = false;
function warnCookieNotSigned(name: string): void {
  unsignedCookieWarned = true;
  runtimeLogger.warn(
    `[MoroJS Security] res.cookie('${name}', ..., { signed: true }) was sent UNSIGNED: this response ` +
      `(AWS Lambda, Vercel Edge and Cloudflare Workers runtimes) does not sign cookies by itself. ` +
      `Install the cookie middleware with a secret (app.use(middleware.cookie({ secret }))) or sign ` +
      `the value yourself before passing it to res.cookie().`,
    'CookieWarning'
  );
}

type ResponseListener = (...args: any[]) => void;

/**
 * The response handed to handlers on runtimes with no Node response object
 * (Lambda, Edge, Workers): the portable core plus the header access and the
 * standard helpers every other server's response has. Methods live on the
 * prototype, so a request allocates the fields below and nothing else.
 *
 * The response is buffered: it is handed to the platform whole once the
 * request handler has returned. There is nothing to stream to (no write() or
 * writeHead()), and the 'finish' and 'close' events are emitted at that
 * moment, for middleware that logs or measures on them.
 */
class PortableResponse implements RuntimeHttpResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: any = null;
  headersSent = false;
  // Set while something waits for this response to be answered (answeredOr)
  private waitingForAnswer: (() => void) | undefined = undefined;
  // Event listeners, by event name; undefined until the first on()
  private eventListeners: Record<string, ResponseListener[]> | undefined = undefined;
  // Every Set-Cookie value once there is more than one. `headers` holds one
  // value per name, so it carries the latest cookie only; with a single cookie
  // this stays undefined and `headers` says it all.
  private cookieList: string[] | undefined = undefined;
  // The request this response answers, and how its runtime tells that the
  // client reached the platform over https (see _overTls). Both are given by
  // the adapter that creates the response.
  private readonly request: HttpRequest | undefined;
  private readonly requestOverTls: ((request: HttpRequest) => boolean) | undefined;

  constructor(request?: HttpRequest, overTls?: (request: HttpRequest) => boolean) {
    this.request = request;
    this.requestOverTls = overTls;
  }

  /**
   * @internal Whether the request arrived over TLS, as the platform in front
   * of the function reports it: what a cookie's `Secure` attribute follows
   * when no `secure` option is given. There is no connection to look at here.
   */
  _overTls(): boolean {
    const check = this.requestOverTls;
    return check !== undefined && this.request !== undefined ? check(this.request) : false;
  }

  // The key a header is stored under, whatever case it is asked for in
  private keyFor(name: string): string {
    const headers = this.headers;
    if (name in headers) return name;
    const lower = name.toLowerCase();
    for (const key in headers) {
      if (key.toLowerCase() === lower) return key;
    }
    return name;
  }

  // The cookies set so far. The list counts only while `headers` still holds
  // its last entry: otherwise `headers` was written to directly, and what it
  // holds now is the one cookie there is.
  private cookiesAt(key: string): string[] {
    const latest = this.headers[key];
    if (latest === undefined) return [];
    const list = this.cookieList;
    return list !== undefined && list[list.length - 1] === latest ? list : [latest];
  }

  // Each cookie is a Set-Cookie header of its own: joined with commas they
  // would reach the browser as a single cookie.
  private storeCookies(key: string, cookies: string[]): void {
    const count = cookies.length;
    if (count === 0) {
      delete this.headers[key];
      this.cookieList = undefined;
      return;
    }
    this.headers[key] = cookies[count - 1] as string;
    this.cookieList = count > 1 ? cookies : undefined;
  }

  private addCookie(cookie: string): this {
    const key = this.keyFor(SET_COOKIE);
    const cookies = this.cookiesAt(key);
    cookies.push(headerValue(cookie));
    this.storeCookies(key, cookies);
    return this;
  }

  /**
   * Every Set-Cookie value in the order it was set, when there is more than
   * one; undefined when `headers` already carries all there is.
   */
  multipleCookies(): string[] | undefined {
    if (this.cookieList === undefined) return undefined;
    const cookies = this.cookiesAt(this.keyFor(SET_COOKIE));
    return cookies.length > 1 ? cookies : undefined;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(data: any): void {
    this.headers[this.keyFor('Content-Type')] = 'application/json';
    // Avoid JSON.stringify if data is already a string
    this.body = typeof data === 'string' ? data : JSON.stringify(data);
    this.answered();
  }

  send(data: string | Buffer): void {
    this.body = data;
    this.answered();
  }

  end(data?: string | Buffer): void {
    if (data !== undefined) this.body = data;
    this.answered();
  }

  private answered(): void {
    this.headersSent = true;
    const waiting = this.waitingForAnswer;
    if (waiting !== undefined) {
      this.waitingForAnswer = undefined;
      waiting();
    }
  }

  /**
   * Settles when `pending` does, or as soon as the response is answered:
   * whichever comes first. A middleware that answers from a callback and
   * never calls next() leaves its chain pending for good; on a server that
   * only strands a promise, here it would keep the invocation from returning.
   */
  answeredOr(pending: Promise<void>): Promise<void> {
    if (this.headersSent) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waitingForAnswer = resolve;
      pending.then(resolve, reject);
    });
  }

  // The built-in compression middleware hands its settings to a response
  // that has this method and leaves json()/send() alone. This response is
  // passed to the platform as one buffered body, and the platform in front of
  // the function (API Gateway, CloudFront, Vercel, Cloudflare) negotiates and
  // applies the encoding, so there is nothing to do with them here.
  _useCompression(_settings: unknown): void {}

  /**
   * @internal The whole response is handed to the platform after the handler
   * returns, and the platform negotiates the content encoding. Middleware that
   * would wrap the response's write path reads this and steps aside.
   */
  get _sentWholeByPlatform(): boolean {
    return true;
  }

  // Just enough of an event emitter for (req, res, next) middleware that
  // waits for the response: res.on('finish', ...) / res.on('close', ...).
  on(event: string, listener: ResponseListener): this {
    const all = this.eventListeners ?? (this.eventListeners = {});
    (all[event] ?? (all[event] = [])).push(listener);
    return this;
  }

  once(event: string, listener: ResponseListener): this {
    const wrapped: ResponseListener = (...args) => {
      this.off(event, wrapped);
      listener.apply(this, args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: ResponseListener): this {
    const list = this.eventListeners?.[event];
    if (list !== undefined) {
      const at = list.indexOf(listener);
      if (at !== -1) list.splice(at, 1);
    }
    return this;
  }

  removeListener(event: string, listener: ResponseListener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: any[]): boolean {
    const list = this.eventListeners?.[event];
    if (list === undefined || list.length === 0) return false;
    // A copy: a once() listener removes itself while the list is walked
    for (const listener of list.slice()) listener.apply(this, args);
    return true;
  }

  /**
   * The request handler has returned and the response is about to be handed
   * to the platform: what 'finish' and 'close' mean on a buffered response.
   * A listener that throws is logged and does not change the response.
   */
  finished(): void {
    if (this.eventListeners === undefined) return;
    for (const event of ['finish', 'close']) {
      try {
        this.emit(event);
      } catch (error) {
        runtimeLogger.error(
          `Response '${event}' listener failed: ${error instanceof Error ? error.message : String(error)}`,
          'Response'
        );
      }
    }
  }

  // The same Set-Cookie value the Node server sends for the same arguments
  cookie(name: string, value: string, options?: any): this {
    if (options?.signed && !unsignedCookieWarned) warnCookieNotSigned(name);
    return this.addCookie(serializeCookie(name, value, options, undefined, this));
  }

  clearCookie(name: string, options?: any): this {
    return this.cookie(name, '', clearCookieOptions(options));
  }

  redirect(url: string, status?: number): void {
    this.statusCode = status || 302;
    this.headers['Location'] = typeof url === 'string' ? headerValue(url) : url;
    this.answered();
  }

  async sendFile(_filePath: string): Promise<void> {
    throw new Error('sendFile not implemented in this runtime');
  }

  // Header access, as on the Node and engine responses. Names are matched
  // without regard to case; a value set twice replaces the first. Set-Cookie
  // is the one header whose values are kept apart instead of joined.
  setHeader(name: string, value: string | number | string[]): this {
    const key = this.keyFor(name);
    if (isSetCookie(key)) {
      const cookies = Array.isArray(value) ? value : [value];
      this.storeCookies(
        key,
        cookies.map(cookie => headerValue(String(cookie)))
      );
    } else {
      this.headers[key] = headerValue(Array.isArray(value) ? value.join(', ') : String(value));
    }
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    const key = this.keyFor(name);
    if (this.cookieList !== undefined && isSetCookie(key)) {
      const cookies = this.cookiesAt(key);
      if (cookies.length > 1) return cookies.slice();
    }
    return this.headers[key];
  }

  hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  removeHeader(name: string): this {
    const key = this.keyFor(name);
    delete this.headers[key];
    if (this.cookieList !== undefined && isSetCookie(key)) this.cookieList = undefined;
    return this;
  }

  getHeaders(): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = { ...this.headers };
    const cookies = this.multipleCookies();
    if (cookies !== undefined) headers[this.keyFor(SET_COOKIE)] = cookies.slice();
    return headers;
  }

  appendHeader(name: string, value: string | string[]): this {
    const key = this.keyFor(name);
    if (isSetCookie(key)) {
      const cookies = this.cookiesAt(key);
      const added = Array.isArray(value) ? value : [value];
      for (let i = 0; i < added.length; i++) cookies.push(headerValue(String(added[i])));
      this.storeCookies(key, cookies);
      return this;
    }
    const added = Array.isArray(value) ? value.join(', ') : value;
    const existing = this.headers[key];
    return this.setHeader(name, existing ? `${existing}, ${added}` : added);
  }

  setBulkHeaders(headers: Record<string, string | number>): this {
    for (const key in headers) {
      const value = headers[key];
      if (value !== undefined) this.setHeader(key, value);
    }
    return this;
  }

  set(
    field: string | Record<string, string | string[] | number>,
    value?: string | string[] | number
  ): this {
    if (typeof field === 'string') {
      if (value !== undefined) this.setHeader(field, value);
    } else {
      for (const key in field) {
        const entry = field[key];
        if (entry !== undefined) this.setHeader(key, entry);
      }
    }
    return this;
  }

  get(field: string): string | string[] | undefined {
    return this.getHeader(field);
  }

  append(field: string, value: string | string[]): this {
    return this.appendHeader(field, value);
  }

  // Standard response helpers: same status codes and bodies as on the Node
  // and engine servers.
  success(data: any, message?: string): void {
    const body: any = { success: true, data };
    if (message !== undefined) body.message = message;
    this.json(body);
  }

  error(error: string, code?: string, message?: string): void {
    const body: any = { success: false, error };
    if (code !== undefined) body.code = code;
    if (message !== undefined) body.message = message;
    this.json(body);
  }

  unauthorized(message: string = 'Authentication required'): void {
    this.statusCode = 401;
    this.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED', message });
  }

  forbidden(message: string = 'Insufficient permissions'): void {
    this.statusCode = 403;
    this.json({ success: false, error: 'Forbidden', code: 'FORBIDDEN', message });
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
    this.json({ success: false, error: 'Bad Request', code: 'BAD_REQUEST', message });
  }

  conflict(message: string): void {
    this.statusCode = 409;
    this.json({ success: false, error: 'Conflict', code: 'CONFLICT', message });
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
    this.json({ success: false, error: 'Validation Failed', code: 'VALIDATION_ERROR', errors });
  }

  rateLimited(retryAfter?: number): void {
    this.statusCode = 429;
    if (retryAfter) this.setHeader('Retry-After', retryAfter.toString());
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

  created(data: any, location?: string): void {
    this.statusCode = 201;
    if (location) this.setHeader('Location', location);
    this.json({ success: true, data });
  }

  noContent(): void {
    this.statusCode = 204;
    this.end();
  }

  paginated(data: any[], pagination: { page: number; limit: number; total: number }): void {
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
}

/**
 * Every Set-Cookie value of a response that set more than one, in the order
 * set; undefined when its `headers` already carries all there is.
 */
export function multipleCookiesOf(response: unknown): string[] | undefined {
  return response instanceof PortableResponse ? response.multipleCookies() : undefined;
}

/**
 * Emit 'finish' and 'close' on a response the request handler is done with.
 * Called by the adapters before they turn it into the platform's response.
 */
export function finishResponse(response: unknown): void {
  if (response instanceof PortableResponse) response.finished();
}

/**
 * Run the global middleware chain (the functions registered with app.use()
 * and the config-driven ones) for a request served through getHandler(), with
 * the dispatch the servers share: same order, same next(err) and error
 * middleware rules. Like the native engine server, a middleware that answers
 * the request without calling next() ends the chain. Returns undefined when
 * the chain ran synchronously; throws, or rejects, with an error no error
 * middleware handled.
 */
export function runGlobalMiddleware(
  middleware: Middleware[],
  req: HttpRequest,
  res: HttpResponse
): void | Promise<void> {
  const chain = dispatchMiddleware(middleware, req, res, 0, undefined, WAIT_UNLESS_ANSWERED);
  if (chain === undefined) return;
  const response: unknown = res;
  return response instanceof PortableResponse ? response.answeredOr(chain) : chain;
}

/**
 * The 500 an adapter answers when the request could not be served at all
 * (the handler threw past every error path, or the request or response could
 * not be adapted). The error is logged here; the client gets the generic body
 * the router sends for a failed handler. Outside production (NODE_ENV, the
 * rule the validation and template errors follow) the error's message is
 * included as `message`, as it always was.
 */
export function handlerFailureBody(error: unknown, requestId?: string): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  runtimeLogger.error(`Request failed: ${message}`, 'RequestError', {
    ...(requestId ? { requestId } : {}),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
  const body: Record<string, unknown> = { success: false, error: 'Internal server error' };
  if (process.env.NODE_ENV !== 'production') body.message = message;
  if (requestId) body.requestId = requestId;
  return JSON.stringify(body);
}

/** The key `name` (given in lower case) is stored under in a header map */
export function headerKeyOf(headers: Record<string, unknown>, name: string): string | undefined {
  if (name in headers) return name;
  for (const key in headers) {
    if (key.toLowerCase() === name) return key;
  }
  return undefined;
}

/**
 * The bytes of a binary response body (a Buffer, a typed array, a DataView or
 * an ArrayBuffer); undefined for anything else.
 */
export function bytesOf(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

/** A request body that could not be parsed as what its Content-Type declares */
export class InvalidRequestBodyError extends Error {
  readonly statusCode = 400;

  constructor() {
    super('Invalid request body');
    this.name = 'InvalidRequestBodyError';
  }
}

/**
 * The text of a Web Request's JSON body, parsed. The body can be read once
 * only, so it is read as text and parsed from that. An empty body is null, as
 * on the Node server; a malformed one throws InvalidRequestBodyError.
 */
export async function readJsonBody(request: Request): Promise<any> {
  const text = await request.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestBodyError();
  }
}

/** The answer to a request whose body could not be parsed: the Node server's 400 */
export function invalidBodyResponse(requestId: string): Response {
  return new Response(
    JSON.stringify({ success: false, error: 'Invalid request body', requestId }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}

/** A Web Response (Vercel Edge, Cloudflare Workers) from what a handler set on `res` */
export function toWebResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Response {
  const runtimeResponse = moroResponse as RuntimeHttpResponse;

  // Handle different response states
  let body = runtimeResponse.body;
  let status = runtimeResponse.statusCode || 200;
  const headers = runtimeResponse.headers || {};

  // If it's a real HttpResponse, we need to extract the data differently
  if ('statusCode' in moroResponse && typeof moroResponse.statusCode === 'number') {
    status = moroResponse.statusCode;
  }

  // Convert headers to Headers object - Avoid Object.entries
  const responseHeaders = new Headers();
  for (const key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key)) {
      const value = headers[key];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          responseHeaders.append(key, value[i]);
        }
      } else {
        responseHeaders.set(key, value);
      }
    }
  }

  // Every cookie is a Set-Cookie header of its own
  const cookies = multipleCookiesOf(moroResponse);
  if (cookies !== undefined) {
    responseHeaders.delete(SET_COOKIE);
    for (let i = 0; i < cookies.length; i++) {
      responseHeaders.append(SET_COOKIE, cookies[i] as string);
    }
  }

  // Handle different body types
  if (typeof body === 'object' && body !== null) {
    if (typeof body.getReader === 'function' || bytesOf(body) !== undefined) {
      // A stream or bytes: sent as they are, under the type the handler set
      if (!responseHeaders.has('Content-Type')) {
        responseHeaders.set('Content-Type', 'application/octet-stream');
      }
    } else {
      body = JSON.stringify(body);
      responseHeaders.set('Content-Type', 'application/json');
    }
  }

  // A Response with one of these statuses cannot be constructed with a body
  if (status === 204 || status === 205 || status === 304) body = null;

  return new Response(body, {
    status,
    headers: responseHeaders,
  });
}

// Paths the URL parser returns unchanged: segments of unreserved characters,
// none starting with a dot (so no `.` or `..` to resolve), no empty segment,
// no query, no fragment, nothing to percent-encode
const PLAIN_PATH = /^\/(?:[A-Za-z0-9_~-]+(?:[./][A-Za-z0-9_~-]+)*\/?)?$/;

export abstract class BaseRuntimeAdapter implements RuntimeAdapter {
  abstract readonly type: RuntimeType;

  abstract adaptRequest(runtimeRequest: any, ...args: any[]): Promise<HttpRequest>;
  abstract adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    runtimeRequest: any
  ): Promise<any>;
  abstract createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): any;

  // Generate UUID without external dependency - optimized version
  protected generateUUID(): string {
    const bytes = randomBytes(16);
    // Set version (4) and variant bits
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    // Convert to hex string directly without intermediate operations
    const hex = bytes.toString('hex');
    return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
  }

  // Common request enhancement
  protected enhanceRequest(baseRequest: Partial<HttpRequest>): HttpRequest {
    const request = baseRequest as HttpRequest;

    // Add common properties
    request.requestId = request.requestId || this.generateUUID();
    request.ip = request.ip || 'unknown';
    request.params = request.params || {};
    request.query = request.query || {};
    request.cookies = request.cookies || {};
    request.files = request.files || {};

    return request;
  }

  /**
   * Whether `request` reached the platform over https. The platform decides
   * how that is known (the request URL, a header it writes); a runtime that
   * cannot tell answers false, and cookies are then `Secure` only when asked.
   */
  protected requestOverTls(_request: HttpRequest): boolean {
    return false;
  }

  // The response for `request`. It is told which request it answers so that
  // res.cookie() can follow the connection the request arrived on.
  protected createMockResponse(request?: HttpRequest): RuntimeHttpResponse {
    return new PortableResponse(request, this.overTls);
  }

  // One function per adapter, so a response stores a reference and nothing is
  // allocated per request
  private readonly overTls = (request: HttpRequest): boolean => this.requestOverTls(request);

  // Parse URL and query parameters
  protected parseUrl(url: string): {
    pathname: string;
    query: Record<string, string>;
  } {
    // A bare path of plain segments (the usual Lambda event path) is its own
    // pathname and has no query: nothing for the URL parser to do
    if (url.charCodeAt(0) === 47 && PLAIN_PATH.test(url)) {
      return { pathname: url, query: {} };
    }

    try {
      const urlObj = new URL(url, 'http://localhost');
      // The parser the Node server and the engine use, so req.query is the
      // same on every runtime: '+' is a space, a malformed escape is kept as
      // sent, the last of a repeated key wins
      const search = urlObj.search;
      return {
        pathname: urlObj.pathname,
        query: search.length > 1 ? parseRawQueryString(search) : {},
      };
    } catch {
      return {
        pathname: url,
        query: {},
      };
    }
  }

  // Parse body based on content type
  protected async parseBody(body: any, contentType?: string): Promise<any> {
    if (!body) return undefined;

    if (typeof body === 'string') {
      if (contentType?.includes('application/json')) {
        try {
          return JSON.parse(body);
        } catch {
          return body;
        }
      }
      return body;
    }

    return body;
  }
}
