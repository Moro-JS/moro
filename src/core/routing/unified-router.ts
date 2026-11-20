// Unified Router - Consolidates Intelligent Router and Core Router
// Combines best features from both systems with zero breaking changes

import {
  PathMatcher,
  CompiledPath,
  parseExtendedPath,
  optionalPathForms,
  type ExtendedPath,
} from './path-matcher.js';
import { decodeParam } from './decode-param.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';
import { createFrameworkLogger } from '../logger/index.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RateLimitCore, type RateLimitConfig } from '../middleware/built-in/rate-limit/index.js';
import { CacheCore, type CacheConfig } from '../middleware/built-in/cache/index.js';
import { ValidationCore, type ValidationConfig } from '../middleware/built-in/validation/index.js';
import { requireAuth } from '../middleware/built-in/auth/helpers.js';
import { ValidationSchema } from '../validation/schema-interface.js';
import { MethodRadixRouter } from './radix-tree.js';
import { useAppConfig } from '../config/config-manager.js';
import { isStrictMiddlewareEnabled, strictRouteMiddleware } from './strict-middleware.js';
import type { AppConfig } from '../../types/config.js';
import {
  clearRepresentationHeaders,
  destroyUnfinishedResponse,
} from '../http/utils/response-headers.js';

const logger = createFrameworkLogger('UnifiedRouter');

// The router's answer to a route that failed and that no error handler
// answered. A response that has not started gets the default 500, without the
// headers that described the body the handler meant to send (a stale
// Content-Encoding or cache lifetime would apply to the error instead). One
// that has started cannot be answered any more: it is destroyed so the client
// is not left waiting for the rest of it.
function answerRouteFailure(res: HttpResponse, body: Record<string, unknown>): void {
  if (res.headersSent) {
    destroyUnfinishedResponse(res);
    return;
  }
  clearRepresentationHeaders(res);
  res.status(500).json(body);
}

// Route validation keeps no state between requests, so one core serves every
// router. Rate-limit counters and cached responses belong to the app whose
// routes they are for: each router holds its own (see UnifiedRouter).
const validationCore = new ValidationCore();

// ===== Types =====

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type RouteHandler<T = any> = (req: HttpRequest, res: HttpResponse) => T | Promise<T>;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: (err?: unknown) => void
) => void | Promise<void>;

export interface AuthConfig {
  roles?: string[];
  permissions?: string[];
  optional?: boolean;
  /**
   * Sign-in is required. This is already the case unless `optional` is true,
   * so `required: true` changes nothing on its own; with a `validator` it
   * makes a denial of a request that has no authenticated user a 401
   * instead of a 403. `required: false` does not make sign-in optional:
   * use `optional: true` for that.
   */
  required?: boolean;
  /**
   * A check of this request beyond roles and permissions, for example that
   * the signed-in user owns the record named in the path. Called with the
   * request once the sign-in, role and permission checks have passed; it may
   * return a promise. A falsy result or a throw denies the request: 403, or
   * 401 when the request has no authenticated user and `required` is true.
   */
  validator?: (req: HttpRequest) => unknown;
}

// Re-export config types from built-in middleware for convenience
export type { RateLimitConfig, CacheConfig, ValidationConfig };

export interface MiddlewarePhases {
  before?: Middleware[];
  after?: Middleware[];
  transform?: Middleware[];
}

export interface RouteSchema {
  method: HttpMethod;
  path: string;
  /** A function, or the response body itself (see StaticBody) */
  handler: RouteHandler | StaticBody | ParamEcho;
  validation?: ValidationConfig;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  middleware?: MiddlewarePhases | Middleware[];
  description?: string;
  tags?: string[];
  /** Fixed reply of a literal handler. A server that can answer it
   *  natively (MoroEngineServer on @morojs/engine >= 1.1.6) does so without
   *  calling into JS; every other server runs `handler`, which sends the
   *  same bytes. */
  static?: StaticResponse;
  /** The engine shape of a param(name) handler on a bare route with exactly
   *  that one parameter: the path segment between prefix and suffix is the
   *  body. MoroEngineServer on @morojs/engine >= 1.1.9 (paramRoutes) answers
   *  it without calling into JS; every other server runs `handler`. */
  paramEcho?: ParamRouteReply;
}

export interface ParamRouteReply {
  name: string;
  prefix: string;
  suffix: string;
  status: number;
  headers: string[] | null;
}

/** The reply a literal handler sends, in the engine's shape. */
export interface StaticResponse {
  status: number;
  /** [name, value, name, value, ...], or null for no headers at all */
  headers: string[] | null;
  body: string | Buffer | null;
}

/** What .handler() accepts in place of a function: the response body itself. */
export type StaticBody = string | Buffer;

export const PARAM_ECHO: unique symbol = Symbol.for('moro.paramEcho');

/** The marker param(name) produces: "answer with this path parameter as the
 *  body". `.handler(param('id'))` on `/user/:id` answers `GET /user/42` with
 *  `42`, as `res.end(req.params.id)` would - and on Moro's native engine, on
 *  a route with nothing else configured, without entering JS at all. */
export interface ParamEcho {
  readonly [PARAM_ECHO]: true;
  readonly name: string;
}

export function param(name: string): ParamEcho {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('param(name) needs the parameter name, e.g. param("id") for "/user/:id"');
  }
  return Object.freeze({ [PARAM_ECHO]: true as const, name });
}

export function isParamEcho(value: unknown): value is ParamEcho {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [PARAM_ECHO]?: unknown })[PARAM_ECHO] === true
  );
}

// Nothing configured that a reply answered inside the engine would skip:
// no auth, validation, rate limit, cache or middleware. (Static replies also
// need a literal path; parameter echoes need exactly one parameter.)
function isBareRoute(schema: Partial<RouteSchema>): boolean {
  const mw = schema.middleware;
  const hasMiddleware = Array.isArray(mw)
    ? mw.length > 0
    : mw !== undefined &&
      Object.keys(mw).some(phase => {
        const list = (mw as Record<string, unknown>)[phase];
        return Array.isArray(list) && list.length > 0;
      });
  return !schema.auth && !schema.validation && !schema.rateLimit && !schema.cache && !hasMiddleware;
}

/**
 * param(name) in place of a handler: the route answers with that path
 * parameter as the body, as res.end(req.params[name]) would. When `:name` is
 * a whole segment of the path, the only parameter in it, and nothing else is
 * configured, the schema also carries `paramEcho` - prefix and suffix around
 * the segment - so a server that can answer it natively does so without
 * calling into JS. The engine echoes the segment as it is on the wire,
 * undecoded; a parameter that needs decoding stays a function
 * handler.
 */
// A reflected path segment is text, never markup: the reply says so on every
// server, so a browser cannot sniff it as HTML.
const PARAM_ECHO_CONTENT_TYPE = 'text/plain; charset=utf-8';

export function compileParamRoute(schema: Partial<RouteSchema>, echo: ParamEcho): RouteSchema {
  const name = echo.name;
  schema.handler = (req: HttpRequest, res: HttpResponse) => {
    const value = (req as { params?: Record<string, unknown> }).params?.[name];
    if (value === undefined) {
      res.end();
      return;
    }
    res.setHeader('Content-Type', PARAM_ECHO_CONTENT_TYPE);
    res.end(String(value));
  };

  const path = schema.path ?? '';
  const segments = path.split('/');
  const marker = `:${name}`;
  const at = segments.indexOf(marker);
  if (at === -1) {
    // An optional parameter (':name?') or a named wildcard ('*name') is that
    // parameter too. The handler above answers it, with an empty body when
    // the path leaves the parameter out; the route has no engine shape.
    if (segments.includes(`${marker}?`) || segments[segments.length - 1] === `*${name}`) {
      return schema as RouteSchema;
    }
    // The router names a parameter after its whole segment, so ":name.json"
    // is a parameter called "name.json" and param('name') would never see it.
    // (":names" is a different parameter, not a misuse; it gets no echo.)
    const partial = segments.some(
      seg => seg.startsWith(marker) && /^[^A-Za-z0-9_$]/.test(seg.slice(marker.length))
    );
    if (partial) {
      throw new Error(
        `param('${name}') needs '${marker}' as a whole segment of the route path; ` +
          `'${path}' has it inside a segment`
      );
    }
    return schema as RouteSchema;
  }
  const rest = segments.slice(at + 1);
  const plainShape =
    !segments.some((seg, i) => i !== at && seg.startsWith(':')) &&
    !path.includes('*') &&
    !rest.includes(''); // no trailing or doubled slash after the parameter
  if (plainShape && isBareRoute(schema)) {
    const prefix = segments.slice(0, at).join('/') + '/';
    const suffix = rest.length > 0 ? '/' + rest.join('/') : '';
    schema.paramEcho = { name, prefix, suffix, status: 200, headers: null };
  }
  return schema as RouteSchema;
}

// A RouteSchema after registerRoute(): a literal body has been compiled into
// a function by compileStaticRoute, so dispatch can call the handler directly.
type RegisteredRouteSchema = RouteSchema & { handler: RouteHandler };

// The content-type res.send() implies for a body it was given no header for:
// the same three cases MoroEngineServer's send() picks a template by, spelled
// out here so an engine-answered reply carries the bytes send() would have.
const STATIC_JSON_START = /^\s*[{[]/;
function impliedContentType(body: StaticBody): string {
  if (typeof body !== 'string') return 'application/octet-stream';
  return STATIC_JSON_START.test(body)
    ? 'application/json; charset=utf-8'
    : 'text/plain; charset=utf-8';
}

/**
 * A literal body in place of a handler: the route answers with exactly that
 * body. A non-empty body goes out as res.send(body) would (status 200, the
 * implied content-type). An empty body has nothing a content-type could
 * describe, so it goes out as res.end() would: status and Content-Length: 0,
 * no header block - 38 bytes less per response, and byte-identical to the
 * engine's own static reply with no headers. When nothing else is configured
 * on the route - no auth, validation, rate limit, cache or middleware, and a
 * literal path - the schema also carries `static`, so a server that can
 * answer it natively does so without calling into JS. Anything configured
 * keeps the route on the normal pipeline, where the handler sends the same
 * bytes after that configuration has run.
 */
export function compileStaticRoute(schema: Partial<RouteSchema>, body: StaticBody): RouteSchema {
  const empty = body.length === 0;
  schema.handler = empty
    ? (_req: HttpRequest, res: HttpResponse) => {
        res.end();
      }
    : (_req: HttpRequest, res: HttpResponse) => {
        res.send(body);
      };

  const path = schema.path ?? '';
  const bare = !path.includes(':') && !path.includes('*') && isBareRoute(schema);
  if (bare) {
    schema.static = {
      status: 200,
      headers: empty ? null : ['content-type', impliedContentType(body)],
      body,
    };
  }
  return schema as RouteSchema;
}

// Canonical uppercase methods - lets dispatch skip toUpperCase for the
// interned method strings every adapter hands over
const UPPERCASE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

// Internal route representation
interface InternalRoute {
  schema: RegisteredRouteSchema;
  compiledPath: CompiledPath;
  // Hoisted from schema at registration so the per-request dispatch is a
  // single monomorphic load instead of a two-level property chase
  handler: RouteHandler;
  isFastPath: boolean; // No middleware, auth, validation, rate limiting
  executionOrder: string[]; // Ordered list of execution phases
  // Route-specific configs (not middleware)
  rateLimitConfig?: RateLimitConfig;
  cacheConfig?: CacheConfig;
  authMiddleware?: Middleware; // Auth keeps middleware since it's using requireAuth helper
  // The route's auth validator, when it declares one; resolved at registration
  authValidator?: AuthValidator;
  // The validator is all the route's auth asks for (no roles or permissions)
  authValidatorOnly?: boolean;
  validationConfig?: ValidationConfig;
}

/**
 * A route as registerRoute() returns it: the handle a caller passes back to
 * runRoutePhases(). Opaque apart from the schema it was registered with.
 */
export interface RegisteredRoute {
  readonly schema: RouteSchema;
}

// ===== Route Builder (Chainable API) =====

export class RouteBuilder {
  private schema: Partial<RouteSchema>;
  private router: UnifiedRouter;

  constructor(method: HttpMethod, path: string, router: UnifiedRouter) {
    this.schema = {
      method,
      path,
      middleware: {} as MiddlewarePhases,
    };
    this.router = router;
  }

  // Validation methods
  validate(config: ValidationConfig): this {
    // Avoid spread operator and Object.assign - manually merge properties
    if (!this.schema.validation) {
      this.schema.validation = config;
    } else {
      if (config.body !== undefined) this.schema.validation.body = config.body;
      if (config.query !== undefined) this.schema.validation.query = config.query;
      if (config.params !== undefined) this.schema.validation.params = config.params;
      if (config.headers !== undefined) this.schema.validation.headers = config.headers;
      // Without this, `.body(schema).validate({ onValidationError })` silently
      // dropped the handler and fell back to the default 400 response.
      if (config.onValidationError !== undefined) {
        this.schema.validation.onValidationError = config.onValidationError;
      }
    }
    return this;
  }

  body<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.body = schema;
    return this;
  }

  query<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.query = schema;
    return this;
  }

  params<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.params = schema;
    return this;
  }

  headers<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.headers = schema;
    return this;
  }

  // Security methods
  auth(config: AuthConfig): this {
    this.schema.auth = config;
    return this;
  }

  rateLimit(config: RateLimitConfig): this {
    this.schema.rateLimit = config;
    return this;
  }

  // Caching
  cache(config: CacheConfig): this {
    this.schema.cache = config;
    return this;
  }

  // Custom middleware
  before(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.before) phases.before = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.before.push(middleware[i] as Middleware);
    }
    return this;
  }

  after(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.after) phases.after = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.after.push(middleware[i] as Middleware);
    }
    return this;
  }

  transform(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.transform) phases.transform = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.transform.push(middleware[i] as Middleware);
    }
    return this;
  }

  use(...middleware: Middleware[]): this {
    return this.after(...middleware);
  }

  // Metadata
  describe(description: string): this {
    this.schema.description = description;
    return this;
  }

  tag(...tags: string[]): this {
    // Avoid spread, use push for better performance
    if (!this.schema.tags) this.schema.tags = [];
    for (let i = 0; i < tags.length; i++) {
      this.schema.tags.push(tags[i] as string);
    }
    return this;
  }

  // Terminal method: a function, the response body itself (see
  // compileStaticRoute), or param(name) (see compileParamRoute).
  handler<T>(handler: RouteHandler<T> | StaticBody | ParamEcho): void {
    if (typeof handler === 'function') {
      // Avoid spread operator - add handler directly
      this.schema.handler = handler;
      this.router.registerRoute(this.schema as RouteSchema);
      return;
    }
    if (typeof handler === 'string' || Buffer.isBuffer(handler)) {
      this.router.registerRoute(compileStaticRoute(this.schema, handler));
      return;
    }
    if (isParamEcho(handler)) {
      this.router.registerRoute(compileParamRoute(this.schema, handler));
      return;
    }
    throw new Error(
      'Handler is required: a function, the response body as a string or Buffer, or param(name)'
    );
  }
}

// ===== Unified Router =====

const routeDone = (): true => true;

const SUPPORTED_AUTH_KEYS = new Set(['roles', 'permissions', 'optional', 'required', 'validator']);

/**
 * A route's `auth` config applies roles, permissions, `optional`, `required`
 * and `validator` - nothing else. Any other key is accepted by the type-loose
 * call sites but never read, so a route that relies on one is not checking
 * what it says. Name those at registration instead of dropping them silently,
 * together with a `required: false` that would be read as "sign-in is
 * optional", which it does not mean. A `validator` that is not a function
 * could never run, so that is an error. Returns the keys it warned about.
 */
export function warnUnsupportedAuthKeys(auth: unknown, where: string): string[] {
  if (!auth || typeof auth !== 'object') return [];
  const config = auth as { validator?: unknown; required?: unknown; optional?: unknown };
  if (config.validator !== undefined && typeof config.validator !== 'function') {
    throw new Error(
      `${where}: auth.validator must be a function (req) => boolean | Promise<boolean>, ` +
        `got ${config.validator === null ? 'null' : typeof config.validator}`
    );
  }
  if (config.required === false && config.optional !== true) {
    logger.warn(
      `${where}: auth option 'required: false' does NOT make sign-in optional - ` +
        `the route still answers 401 to a request that is not signed in. Use optional: true for that.`,
      'Auth'
    );
  }
  const unsupported = Object.keys(auth).filter(key => !SUPPORTED_AUTH_KEYS.has(key));
  if (unsupported.length === 0) return unsupported;
  logger.warn(
    `${where}: auth option${unsupported.length > 1 ? 's' : ''} ${unsupported
      .map(key => `'${key}'`)
      .join(', ')} ${unsupported.length > 1 ? 'are' : 'is'} NOT enforced. ` +
      `Route auth applies only roles, permissions, optional, required and validator; ` +
      `do any other check inside the validator, the handler or .before(fn).`,
    'Auth'
  );
  return unsupported;
}

type AuthValidator = (req: HttpRequest) => unknown;

// The answer to a request the route's auth validator turned down: 401 when
// nobody is signed in and the route says sign-in is required, 403 otherwise.
function denyByAuthValidator(auth: AuthConfig, req: HttpRequest, res: HttpResponse): void {
  if (res.headersSent) return;
  const signedIn =
    req.auth?.isAuthenticated === true || (req.user !== undefined && req.user !== null);
  if (!signedIn && auth.required === true) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      message: 'You must be logged in to access this resource',
    });
    return;
  }
  res.status(403).json({
    success: false,
    error: 'Access denied',
    message: 'Authorization check failed',
  });
}

function authValidatorThrew(error: unknown, req: HttpRequest): void {
  logger.warn('Route auth validator threw; request denied', 'Auth', {
    route: `${req.method} ${req.path}`,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Run a route's auth `validator` for this request. A truthy result lets the
 * request continue; a falsy one or a throw answers it (see AuthConfig), which
 * the caller sees through res.headersSent. undefined when the validator
 * answered synchronously, else the promise it is waiting on. Module routes
 * call this too, so every registration form denies the same way.
 */
export function runAuthValidator(
  auth: AuthConfig,
  req: HttpRequest,
  res: HttpResponse
): void | Promise<void> {
  const validator = auth.validator as AuthValidator;
  let verdict: any;
  try {
    verdict = validator(req);
  } catch (error) {
    authValidatorThrew(error, req);
    denyByAuthValidator(auth, req, res);
    return;
  }
  if (verdict && typeof verdict.then === 'function') {
    return (verdict as Promise<unknown>).then(
      allowed => {
        if (!allowed) denyByAuthValidator(auth, req, res);
      },
      error => {
        authValidatorThrew(error, req);
        denyByAuthValidator(auth, req, res);
      }
    );
  }
  if (!verdict) denyByAuthValidator(auth, req, res);
}

/**
 * The rate-limit and cache phases of a route, on the counters and the store
 * of the current app's router (see UnifiedRouter.getInstance). An app's own
 * module routes use its router's checkRateLimit / tryCache directly.
 */
export function checkRouteRateLimit(
  req: HttpRequest,
  res: HttpResponse,
  config: RateLimitConfig
): Promise<void> {
  return UnifiedRouter.getInstance().checkRateLimit(req, res, config);
}

export function tryRouteCache(
  req: HttpRequest,
  res: HttpResponse,
  config: CacheConfig
): Promise<boolean> {
  return UnifiedRouter.getInstance().tryCache(req, res, config);
}

/**
 * Size the store behind route caching (`.cache()`, a direct route's `cache`,
 * a module route's `cache`) and set the lifetime of a route that declares
 * caching without a `ttl`, for the current app's router. Each app does this
 * for its own router when it is created, from its `modules.cache.maxSize` and
 * `modules.cache.defaultTtl`; called with nothing it restores the defaults
 * (5,000 entries, no default lifetime). It decides nothing about which routes
 * are cached: only a route that declares caching is.
 *
 * @internal
 */
export function configureRouteCache(
  options: { maxEntries?: number; defaultTtl?: number } = {}
): void {
  UnifiedRouter.getInstance().configureCache(options);
}

const GUARD_FACTORY = Symbol.for('morojs.guard-factory');

/**
 * A guard factory handed over uncalled - `.before(requireAuth)` instead of
 * `.before(requireAuth())` - gets run as if it were the middleware: it builds
 * the real guard, returns it without running it, and the request goes on
 * unchecked. Name it when the route is registered. Returns whether it warned.
 */
export function warnUncalledGuard(candidate: unknown, where: string): boolean {
  if (typeof candidate !== 'function' || !(candidate as any)[GUARD_FACTORY]) return false;
  const name = candidate.name || 'guard';
  logger.warn(
    `${where}: '${name}' was passed uncalled, so it does NOT protect anything - ` +
      `the request continues without the check. Call it: ${name}().`,
    'Auth'
  );
  return true;
}

// Characters that are pattern syntax in other routers. Two uses of them are
// route syntax here - ':name?' as the last segments of a path and '*' as its
// last segment (see parseExtendedPath) - and nothing else is.
const OTHER_PATH_SYNTAX = /[*+?()[\]{}|^$\\]/g;

const charactersIn = (text: string): string[] => [...new Set(text.match(OTHER_PATH_SYNTAX) ?? [])];
const quoted = (characters: string[]): string => characters.map(c => `'${c}'`).join(', ');

/**
 * One warning for a route whose path uses pattern syntax this router does not
 * have. Such a route keeps answering what it has answered; the warning says
 * what that is, because it is rarely what the path was written to mean.
 *
 *   - '/users/:id(\\d+)', '/tags/:name+': the characters are part of the
 *     parameter's name
 *   - '/proxy/:name/(.*)', '/q/:a/b?x': in the fixed text of a route with
 *     parameters they are matched differently by the Node.js server and the
 *     native engine
 *   - '/files/**', '/img/*.png': a '*' that is not a whole last segment is
 *     the character itself in a path without parameters
 *   - '/search?debug': a '?' in a path without parameters; a request path
 *     never carries the query string
 *
 * Trailing optional parameters ('/users/:id?') and a wildcard as the last
 * segment ('/files/*', '/files/*path') are route syntax and are not warned
 * about; `extended` is what parseExtendedPath read from the path. Returns the
 * characters it warned about.
 */
export function warnUnsupportedPathSyntax(
  method: string,
  path: string,
  extended?: ExtendedPath | null
): string[] {
  if (typeof path !== 'string' || path.search(OTHER_PATH_SYNTAX) === -1) return [];
  const route = `${method} ${path}`;
  if (extended === undefined) extended = parseExtendedPath(path, route);

  // What is left once the supported forms are taken out: the path in front of
  // the optional parameters or the wildcard, and the optional parameters as
  // plain ones
  const rest =
    extended === null ? path : extended.base + extended.optional.map(name => `/:${name}`).join('');
  if (rest.search(OTHER_PATH_SYNTAX) === -1) return [];

  const segments = rest.split('/');
  const parameters = segments.filter(segment => segment.startsWith(':'));
  if (parameters.length === 0) {
    // Every character of such a path stands for itself
    const found: string[] = [];
    if (rest.includes('?')) {
      logger.warn(
        `Route ${route} contains '?'. A route path is matched against the request path, which ` +
          `never includes the query string: the Node.js server never matches this route, and the ` +
          `native engine answers it for '${path.slice(0, path.indexOf('?'))}'. Register the path ` +
          `without the query string and read req.query in the handler.`,
        'Routes'
      );
      found.push('?');
    }
    if (rest.includes('*')) {
      logger.warn(
        `Route ${route} contains '*' where it is not a wildcard, so it is matched as the ` +
          `character itself. A wildcard is '*' (or '*name') as the whole last segment of the ` +
          `path: '/files/*' answers everything under '/files/', '/*' everything.`,
        'Routes'
      );
      found.push('*');
    }
    return found;
  }

  const inNames = charactersIn(parameters.join('/'));
  const inFixedText = charactersIn(segments.filter(segment => !segment.startsWith(':')).join('/'));
  const found = [...new Set([...inNames, ...inFixedText])];
  const parts = [
    `Route ${route} contains ${quoted(found)}, which ${found.length > 1 ? 'are' : 'is'} not ` +
      `route syntax here: patterns are not supported. (An optional parameter is ':name?' as ` +
      `the last segment, a wildcard is '*' as the last segment.)`,
  ];
  if (inNames.length > 0) {
    const names = parameters.filter(name => name.search(OTHER_PATH_SYNTAX) !== -1);
    parts.push(
      `In ${names.map(name => `'${name}'`).join(', ')} the character is part of the ` +
        `parameter's name (req.params['${names[0]?.slice(1)}']).`
    );
  }
  if (inFixedText.length > 0) {
    parts.push(
      `In the fixed text of the path ${quoted(inFixedText)} ${
        inFixedText.length > 1 ? 'are' : 'is'
      } not matched the same way by the Node.js server and the native engine.`
    );
  }
  parts.push(
    `Register an explicit route for each URL shape instead (.params() to check the form of a ` +
      `parameter).`
  );
  logger.warn(parts.join(' '), 'Routes');
  return found;
}

/** warnUncalledGuard over a middleware list, or over every phase of one. */
export function warnUncalledGuards(middleware: unknown, where: string): void {
  if (!middleware || typeof middleware !== 'object') return;
  const lists = Array.isArray(middleware) ? [middleware] : Object.values(middleware);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) warnUncalledGuard(entry, where);
  }
}

/**
 * Whether a value handed to next() is an error that must abort the chain.
 * Follows the standard (req, res, next) contract: any truthy argument is an
 * error, except the 'route' / 'router' skip tokens, which carry no error and
 * simply advance here. A falsy argument (next(), next(null), next(undefined))
 * is a plain advance, so next can still be passed as a Node-style callback.
 */
export function isNextError(err: unknown): boolean {
  return !!err && err !== 'route' && err !== 'router';
}

// The promise a phase is waiting on, or undefined when the value it got back
// is not one: the cores are asynchronous today, and one that becomes
// synchronous must not be mistaken for a pending phase.
function pendingOf(value: unknown): Promise<unknown> | undefined {
  return value && typeof (value as any).then === 'function'
    ? (value as Promise<unknown>)
    : undefined;
}

export class UnifiedRouter {
  // The current router: the one getInstance() returns. Every app has its own
  // router; this is the router of the current app (see getInstance).
  private static instance: UnifiedRouter | null = null;
  // The routers of the apps created since the last reset(), oldest first.
  // Held weakly: an app nothing refers to any more takes its router with it.
  private static appRouters: WeakRef<UnifiedRouter>[] = [];
  // The router of the app whose route files are being loaded, if any
  private static loading: UnifiedRouter | null = null;

  private readonly poolManager = ObjectPoolManager.getInstance();

  // Route storage optimized for different access patterns
  // OPTIMIZATION: Separate maps per method for faster lookup (no string concat needed)
  // Method -> path -> route. A Map (not a plain object) so the per-request
  // lookup keyed by a non-constant method string stays a monomorphic Map.get
  // instead of a megamorphic keyed object load.
  private staticRoutesByMethod = new Map<string, Map<string, InternalRoute>>([
    ['GET', new Map<string, InternalRoute>()],
    ['POST', new Map<string, InternalRoute>()],
    ['PUT', new Map<string, InternalRoute>()],
    ['DELETE', new Map<string, InternalRoute>()],
    ['PATCH', new Map<string, InternalRoute>()],
    ['HEAD', new Map<string, InternalRoute>()],
    ['OPTIONS', new Map<string, InternalRoute>()],
  ]);
  private dynamicRoutesBySegments = new Map<number, InternalRoute[]>(); // Grouped by segment count
  private fastPathRoutes = new Set<InternalRoute>(); // Routes with no middleware
  private allRoutes: InternalRoute[] = []; // For iteration/inspection
  // Told of each route registered from now on (see setRouteListener)
  private routeListener: ((schema: RouteSchema) => void) | undefined;
  // Routes already told that their path uses syntax the router does not have
  private pathSyntaxWarned = new Set<string>();

  // NEW: Radix tree for fast dynamic route matching
  private radixRouter = new MethodRadixRouter();

  // Statistics
  private stats = {
    totalRoutes: 0,
    staticRoutes: 0,
    dynamicRoutes: 0,
    fastPathRoutes: 0,
    requestCount: 0,
    fastPathHits: 0,
    staticHits: 0,
    dynamicHits: 0,
    cacheHits: 0,
    radixHits: 0,
  };

  constructor() {
    logger.debug('UnifiedRouter initialized', 'Initialization');
  }

  // User-registered global error handler (set via Moro.setErrorHandler)
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;

  // Lifecycle hook manager (set via Moro) so 'error' hooks observe handler
  // errors — the router swallows them here, so the server-level error
  // boundary never sees them.
  private hookManager?: any;

  // What follows is declared after the fields the dispatch path reads, which
  // keep the places in the object they have always had.

  // Counters of the routes that declare a rate limit and the store of the
  // ones that declare caching: this router's own, so two apps in a process
  // neither count against each other's limits nor serve each other's
  // cached responses. The limiter runs a sweep timer, so it exists only
  // once a route asks for it and goes when the app is closed.
  private rateLimitCore: RateLimitCore | undefined;
  private readonly cacheCore = new CacheCore();

  // Created by getInstance() while no app existed; the first app created
  // takes it over, with the routes registered on it so far.
  private standalone = false;
  // The app this router belongs to was closed
  private retired = false;
  // The app this router belongs to, for getApp()
  private owner: unknown;

  /**
   * The configuration of the app this router belongs to; undefined on a
   * router no app owns. Code that runs inside a request reads it through the
   * server that received the request (see configForRequest).
   * @internal
   */
  appConfig: Readonly<AppConfig> | undefined;

  // routing.strictMiddleware of the app this router belongs to: the routes
  // registered on it get their three-parameter middleware under the strict
  // contract (see strict-middleware.ts). Read when a route is registered,
  // never per request.
  private strictMiddleware = false;

  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): void {
    this.errorHandler = fn;
  }

  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  // Invoke the registered error handler (if any). Returns true if it produced a response.
  private async invokeErrorHandler(
    err: any,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<boolean> {
    // Error hooks are observational: fire-and-forget so a slow or throwing
    // observer can never delay or alter the error response.
    if (
      this.hookManager &&
      (this.hookManager.hasHooks === undefined || this.hookManager.hasHooks('error'))
    ) {
      void Promise.resolve(
        this.hookManager.execute('error', { request: req, response: res, error: err })
      ).catch((hookError: any) =>
        logger.error('Error hook error', 'Hooks', {
          error: hookError instanceof Error ? hookError.message : String(hookError),
        })
      );
    }

    if (!this.errorHandler || res.headersSent) return false;
    try {
      const result = this.errorHandler(err, req, res);
      if (result && typeof (result as any).then === 'function') {
        await result;
      }
      return res.headersSent;
    } catch (handlerErr) {
      logger.error('Error handler itself threw', 'Execution', {
        error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
      });
      return false;
    }
  }

  /**
   * The router of the current app. Every app has its own router; this is how
   * code that is not handed an app reaches one: the standalone route builders
   * (createRoute, defineRoute), the facades that predate per-app routers, and
   * tests.
   *
   * The current app is the one whose route files are being loaded
   * (app.loadRoutes, file-based routing); otherwise the app created most
   * recently that has not been closed; otherwise, when every app has been
   * closed, the one created most recently. While no app exists the router
   * returned here stands alone, and the first app created takes it over
   * together with the routes registered on it so far.
   */
  static getInstance(): UnifiedRouter {
    if (!this.instance) {
      this.instance = new UnifiedRouter();
      this.instance.standalone = true;
      logger.info(`UnifiedRouter initialized (PID: ${process.pid})`, 'Router');
    }
    return this.instance;
  }

  /**
   * The router of an app that is being created. It becomes the current
   * router. A router that getInstance() created before any app existed is
   * the first app's, so routes registered standalone before createApp() are
   * served by that app; every other app starts with an empty router.
   * @internal
   */
  static createForApp(owner?: unknown, config?: Readonly<AppConfig>): UnifiedRouter {
    const waiting = this.instance !== null && this.instance.standalone ? this.instance : null;
    const router = waiting ?? new UnifiedRouter();
    if (waiting === null) logger.info(`UnifiedRouter initialized (PID: ${process.pid})`, 'Router');
    router.standalone = false;
    router.owner = owner;
    router.appConfig = config;
    router.strictMiddleware = isStrictMiddlewareEnabled(config);
    if (router.strictMiddleware) {
      // Routes registered before the app existed are this app's routes too
      for (const route of router.allRoutes) {
        const schema = route.schema;
        if (schema.middleware) {
          schema.middleware = strictRouteMiddleware(
            schema.middleware,
            `${schema.method} ${schema.path}`
          );
        }
      }
    }
    this.appRouters = this.appRouters.filter(ref => ref.deref() !== undefined);
    this.appRouters.push(new WeakRef(router));
    if (this.loading === null) {
      this.instance = router;
    } else if (this.loading.appConfig !== undefined) {
      // Created from inside a route file another app is loading: that app
      // stays current, with its configuration, until its files are loaded
      useAppConfig(this.loading.appConfig);
    }
    return router;
  }

  /**
   * The app this router belongs to was closed (`closed` true) or is
   * listening again (false). A closed app is not the current app while
   * another one is open.
   * @internal
   */
  /**
   * Call `listener` with each route registered on `router` from now on
   * (undefined stops it). The app uses it once it has handed routes to its
   * server, so that a route registered after listen() is handed over too, or
   * takes back an engine-answered route it shadows.
   * @internal
   */
  static setRouteListener(
    router: UnifiedRouter,
    listener: ((schema: RouteSchema) => void) | undefined
  ): void {
    router.routeListener = listener;
  }

  /**
   * The app this router belongs to was closed (`closed` true) or is
   * listening again (false). A closed app is not the current app while
   * another one is open.
   * @internal
   */
  static setClosed(router: UnifiedRouter, closed: boolean): void {
    if (router.retired === closed) return;
    router.retired = closed;
    if (closed && router.rateLimitCore !== undefined) {
      // Stops the sweep timer; a route that is hit again starts a new limiter
      router.rateLimitCore.clear();
      router.rateLimitCore = undefined;
    }
    this.selectCurrent();
  }

  /**
   * Make `router` the current one while its app loads route files, so that a
   * file which registers through getApp() or a standalone builder lands on
   * the app that loads it. Returns the function that ends the scope.
   * @internal
   */
  static enterLoading(router: UnifiedRouter): () => void {
    const outer = this.loading;
    const before = this.instance;
    this.loading = router;
    this.instance = router;
    if (router.appConfig !== undefined) useAppConfig(router.appConfig);
    return () => {
      this.loading = outer;
      // Back to what was current, unless a reset() in between dropped it;
      // selectCurrent() then moves on to an app created meanwhile.
      if (this.instance === router) this.instance = before;
      this.selectCurrent();
    };
  }

  /**
   * The app the current router belongs to, if an app owns it.
   * @internal
   */
  static currentOwner(): unknown {
    return this.instance !== null ? this.instance.owner : undefined;
  }

  // The current router after an app was closed, reopened or finished loading
  // its route files. A router no app owns (getInstance() before any app, or
  // after reset()) stays current until an app is created.
  private static selectCurrent(): void {
    if (this.loading !== null) {
      this.instance = this.loading;
    } else {
      if (this.instance !== null && this.instance.standalone) return;
      let newest: UnifiedRouter | null = null;
      let newestOpen: UnifiedRouter | null = null;
      for (let i = this.appRouters.length - 1; i >= 0; i--) {
        const router = (this.appRouters[i] as WeakRef<UnifiedRouter>).deref();
        if (router === undefined) continue;
        if (newest === null) newest = router;
        if (!router.retired) {
          newestOpen = router;
          break;
        }
      }
      const current = newestOpen ?? newest;
      // Nothing to choose from (every app was created before the last
      // reset()): what is current stays.
      if (current === null) return;
      this.instance = current;
    }
    if (this.instance.appConfig !== undefined) useAppConfig(this.instance.appConfig);
  }

  /**
   * Forget every router and empty the ones apps hold: their routes, their
   * rate-limit counters and their cached responses. An app created before
   * the reset keeps running but answers 404 until routes are registered on
   * it again, and the next getInstance() or createApp() starts from an empty
   * router. For tests: this is what isolates one test from the apps of the
   * one before.
   */
  static reset(): void {
    const routers = this.appRouters.map(ref => ref.deref());
    if (this.instance) routers.push(this.instance);
    for (const router of routers) {
      if (router === undefined) continue;
      router.clearAllRoutes();
      router.clearRouteState();
    }
    this.appRouters = [];
    this.loading = null;
    this.instance = null;
  }

  // Counters and cached responses of this router's routes, and what the app
  // configured for the route cache
  private clearRouteState(): void {
    if (this.rateLimitCore !== undefined) {
      this.rateLimitCore.clear();
      this.rateLimitCore = undefined;
    }
    this.cacheCore.clear();
    this.cacheCore.configure();
  }

  /**
   * The rate-limit phase of a route on this router's counters, for a caller
   * that runs its own pipeline around the handler (module routes).
   */
  checkRateLimit(req: HttpRequest, res: HttpResponse, config: RateLimitConfig): Promise<void> {
    return (this.rateLimitCore ??= new RateLimitCore()).checkLimit(req, res, config);
  }

  /** The cache phase of a route on this router's store; see checkRateLimit. */
  tryCache(req: HttpRequest, res: HttpResponse, config: CacheConfig): Promise<boolean> {
    return this.cacheCore.tryGet(req, res, config);
  }

  /**
   * Size the store behind this router's route caching and set the lifetime
   * of a route that declares caching without a `ttl`; see configureRouteCache.
   */
  configureCache(options: { maxEntries?: number; defaultTtl?: number } = {}): void {
    this.cacheCore.configure(options);
  }

  /**
   * Clear all routes (useful for testing)
   */
  clearAllRoutes(): void {
    for (const methodMap of this.staticRoutesByMethod.values()) methodMap.clear();
    this.dynamicRoutesBySegments.clear();
    this.fastPathRoutes.clear();
    this.allRoutes = [];
    this.radixRouter.clear();
    this.stats = {
      totalRoutes: 0,
      staticRoutes: 0,
      dynamicRoutes: 0,
      fastPathRoutes: 0,
      requestCount: 0,
      fastPathHits: 0,
      staticHits: 0,
      dynamicHits: 0,
      cacheHits: 0,
      radixHits: 0,
    };
    logger.debug('UnifiedRouter routes cleared', 'Reset');
  }

  // ===== Route Registration =====

  /**
   * Register a route (internal method) - OPTIMIZED
   */
  registerRoute(schema: RouteSchema): RegisteredRoute {
    if (schema.auth) warnUnsupportedAuthKeys(schema.auth, `${schema.method} ${schema.path}`);
    if (schema.middleware) warnUncalledGuards(schema.middleware, `${schema.method} ${schema.path}`);
    const routeKey = `${schema.method} ${schema.path}`;
    // Trailing optional parameters or a wildcard, if the path has them. One
    // of them in a place where it cannot work throws: the route is refused
    // here instead of being registered meaning something else.
    const extended = parseExtendedPath(schema.path, routeKey);
    if (this.strictMiddleware && schema.middleware) {
      schema.middleware = strictRouteMiddleware(schema.middleware, routeKey);
    }
    // Said once for a route, also when it is registered again
    if (!this.pathSyntaxWarned.has(routeKey)) {
      if (warnUnsupportedPathSyntax(schema.method, schema.path, extended).length > 0) {
        this.pathSyntaxWarned.add(routeKey);
      }
    }

    // A literal body in place of a handler (see compileStaticRoute). Every
    // entry point lands here - the builder, app.get(path, body), route(schema)
    // - so this is where the body becomes a handler and, on a bare route, a
    // reply the native engine can answer itself.
    if (typeof schema.handler !== 'function') {
      const given: unknown = schema.handler;
      if (isParamEcho(given)) {
        compileParamRoute(schema, given);
      } else if (typeof given === 'string' || Buffer.isBuffer(given)) {
        compileStaticRoute(schema, given);
      } else {
        throw new Error(
          `Handler for ${schema.method} ${schema.path} must be a function, ` +
            'the response body as a string or Buffer, or param(name)'
        );
      }
    }
    // From here on the handler is a function, whichever form was registered.
    const registered = schema as RegisteredRouteSchema;

    // OPTIMIZATION: Skip PathMatcher.compile for better performance
    // Determine if static route (optimized check)
    const pathLen = schema.path.length;
    let hasParams = false;
    for (let i = 0; i < pathLen; i++) {
      if (schema.path.charCodeAt(i) === 58) {
        // ':' character
        hasParams = true;
        break;
      }
    }

    const isStatic = !hasParams && extended === null;
    const isFastPath = this.isFastPathRoute(schema);

    // OPTIMIZATION: Lazy execution order building (only when needed)
    const executionOrder = isFastPath ? [] : this.buildExecutionOrder(schema);

    // OPTIMIZATION: Lazy auth middleware creation (only create when needed, not during registration)
    // This speeds up route registration significantly
    const route: InternalRoute = {
      schema: registered,
      compiledPath: null as any, // Will be set lazily if needed
      handler: registered.handler,
      isFastPath,
      executionOrder,
      rateLimitConfig: schema.rateLimit,
      cacheConfig: schema.cache,
      authMiddleware: undefined, // Will be created lazily on first request
      authValidator:
        typeof schema.auth?.validator === 'function' ? schema.auth.validator : undefined,
      authValidatorOnly: !schema.auth?.roles?.length && !schema.auth?.permissions?.length,
      validationConfig: schema.validation,
    } as any;

    // Store in appropriate structures
    if (isStatic) {
      const methodMap = this.staticRoutesByMethod.get(schema.method);
      if (methodMap) {
        methodMap.set(schema.path, route);
      }
      this.stats.staticRoutes++;

      // DON'T add static routes to radix tree - Map is faster
    } else {
      // Add ONLY dynamic routes to radix tree (primary lookup for dynamic routes)
      if (extended === null) {
        this.radixRouter.addRoute(schema.method, schema.path, route);
      } else if (extended.wildcard !== undefined) {
        // '/files/*': everything below '/files/', once no other route took it
        this.radixRouter.addRoute(schema.method, extended.base, route, {
          wildcard: extended.wildcard,
        });
      } else {
        // '/users/:id?': the route for '/users' and for '/users/:id', wherever
        // no route is registered for exactly that path
        for (const form of optionalPathForms(extended)) {
          this.radixRouter.addRoute(schema.method, form, route, { optional: true });
        }
      }

      // Keep segment-based grouping for backward compatibility
      const segments = this.countSegmentsFast(schema.path);
      let routes = this.dynamicRoutesBySegments.get(segments);
      if (!routes) {
        routes = [];
        this.dynamicRoutesBySegments.set(segments, routes);
      }
      routes.push(route);
      this.stats.dynamicRoutes++;
    }

    if (isFastPath) {
      this.fastPathRoutes.add(route);
      this.stats.fastPathRoutes++;
    }

    this.allRoutes.push(route);
    this.stats.totalRoutes++;
    if (this.routeListener !== undefined) this.routeListener(route.schema);

    // OPTIMIZATION: Skip logging in production for performance
    // Most routes are registered once at startup, so this isn't a hot path
    // But reducing allocations still helps
    return route;
  }

  /**
   * Fast segment counting without allocations
   */
  private countSegmentsFast(path: string): number {
    let count = 0;
    let inSegment = false;
    const len = path.length;

    for (let i = 0; i < len; i++) {
      const char = path.charCodeAt(i);
      if (char === 47) {
        // '/' character
        inSegment = false;
      } else if (!inSegment) {
        inSegment = true;
        count++;
      }
    }

    return count;
  }

  /**
   * Compile specialized param extractor for common cases. Every value is
   * percent-decoded (`/user/%30%30%34%32` names the id `0042`); a malformed
   * escape keeps the raw text, so an odd URL is a 400 for the handler to
   * give, not a 500 from a URIError here. A value without a '%' is returned
   * as is, which is the common case and costs no call.
   */
  private compileParamExtractor(
    compiledPath: CompiledPath
  ): (matches: RegExpMatchArray) => Record<string, string> {
    const paramNames = compiledPath.paramNames;
    const paramCount = paramNames.length;
    const decode = decodeParam;

    // Specialized extractors for common cases
    if (paramCount === 0) {
      return () => ({}); // No allocation needed
    } else if (paramCount === 1) {
      const name = paramNames[0] as string;
      return matches => ({ [name]: decode(matches[1] as string) });
    } else if (paramCount === 2) {
      const name1 = paramNames[0] as string;
      const name2 = paramNames[1] as string;
      return matches => ({
        [name1]: decode(matches[1] as string),
        [name2]: decode(matches[2] as string),
      });
    } else if (paramCount === 3) {
      const name1 = paramNames[0] as string;
      const name2 = paramNames[1] as string;
      const name3 = paramNames[2] as string;
      return matches => ({
        [name1]: decode(matches[1] as string),
        [name2]: decode(matches[2] as string),
        [name3]: decode(matches[3] as string),
      });
    } else {
      // Generic path for 4+ params
      return matches => {
        const params: Record<string, string> = {};
        for (let i = 0; i < paramCount; i++) {
          params[paramNames[i] as string] = decode(matches[i + 1] as string);
        }
        return params;
      };
    }
  }

  /**
   * Chainable API methods
   */
  get(path: string): RouteBuilder {
    return new RouteBuilder('GET', path, this);
  }

  post(path: string): RouteBuilder {
    return new RouteBuilder('POST', path, this);
  }

  put(path: string): RouteBuilder {
    return new RouteBuilder('PUT', path, this);
  }

  delete(path: string): RouteBuilder {
    return new RouteBuilder('DELETE', path, this);
  }

  patch(path: string): RouteBuilder {
    return new RouteBuilder('PATCH', path, this);
  }

  head(path: string): RouteBuilder {
    return new RouteBuilder('HEAD', path, this);
  }

  options(path: string): RouteBuilder {
    return new RouteBuilder('OPTIONS', path, this);
  }

  /**
   * Schema-first route registration
   */
  route(schema: RouteSchema): void {
    this.registerRoute(schema);
  }

  /**
   * Direct API (for backward compatibility)
   */
  addRoute(
    method: HttpMethod,
    path: string,
    handler: RouteHandler | StaticBody,
    middleware: Middleware[] = []
  ): RegisteredRoute {
    return this.registerRoute({
      method,
      path,
      handler,
      middleware,
    });
  }

  // ===== Route Matching =====

  /**
   * Find a matching route for the request - HYBRID OPTIMIZED
   * Returns boolean (sync) for fast-path routes, Promise<boolean> for others
   */
  handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> | boolean {
    this.stats.requestCount++;

    // Adapters hand over interned uppercase method strings - the Set probe
    // skips a per-request toUpperCase call (and its scan) in the common case
    const rawMethod = req.method;
    const method = (
      rawMethod && UPPERCASE_METHODS.has(rawMethod) ? rawMethod : rawMethod?.toUpperCase()
    ) as HttpMethod;
    const path = req.path;

    // FAST PATH 1: Try static route Map lookup first (fastest possible - no string concat)
    const methodMap = this.staticRoutesByMethod.get(method);
    if (methodMap) {
      const staticRoute = methodMap.get(path);

      if (staticRoute) {
        // (params untouched here: every adapter req initializes params, and
        // the engine adapter materializes it lazily on first handler access)

        // Fast-path execution (no middleware)
        if (staticRoute.isFastPath) {
          try {
            const result = staticRoute.handler(req, res);

            if (result && typeof (result as any).then === 'function') {
              return (result as Promise<any>)
                .then(actualResult => {
                  if (actualResult !== undefined && !res.headersSent) {
                    res.json(actualResult);
                  }
                  return true;
                })
                .catch(async err => {
                  const handled = await this.invokeErrorHandler(err, req, res);
                  if (!handled) answerRouteFailure(res, { error: 'Internal server error' });
                  return true;
                });
            } else {
              if (result !== undefined && !res.headersSent) {
                res.json(result);
              }
              return true;
            }
          } catch (err) {
            return (async () => {
              const handled = await this.invokeErrorHandler(err, req, res);
              if (!handled) answerRouteFailure(res, { error: 'Internal server error' });
              return true;
            })();
          }
        }

        // Non-fast-path static route
        return this.runRoute(staticRoute, req, res, {});
      }
    }

    // FAST PATH 2: Try radix tree for dynamic routes
    const radixResult = this.radixRouter.findRoute(method, path);
    if (radixResult) {
      const route = radixResult.handler as InternalRoute;
      req.params = radixResult.params;

      // Fast-path dynamic routes (no middleware)
      if (route.isFastPath) {
        try {
          const result = route.handler(req, res);

          if (result && typeof (result as any).then === 'function') {
            return (result as Promise<any>)
              .then(actualResult => {
                if (actualResult !== undefined && !res.headersSent) {
                  res.json(actualResult);
                }
                return true;
              })
              .catch(async err => {
                const handled = await this.invokeErrorHandler(err, req, res);
                if (!handled) answerRouteFailure(res, { error: 'Internal server error' });
                return true;
              });
          } else {
            if (result !== undefined && !res.headersSent) {
              res.json(result);
            }
            return true;
          }
        } catch (err) {
          return (async () => {
            const handled = await this.invokeErrorHandler(err, req, res);
            if (!handled) answerRouteFailure(res, { error: 'Internal server error' });
            return true;
          })();
        }
      }

      // Non-fast-path dynamic routes (with middleware)
      return this.runRoute(route, req, res, radixResult.params);
    }

    // No route found. A request target with no leading slash is refused as
    // the Node servers' parser refuses it, instead of going on as a 404.
    if (path.charCodeAt(0) !== 47) return this.refuseTargetWithoutSlash(path, res);
    return false;
  }

  // 'admin/users/1' in the request line. Node's HTTP parser answers 400 before
  // the framework sees the request; a server that hands such a target on (the
  // native engine) gets the same status here. '*' (OPTIONS *) and an
  // absolute-form target are valid request targets that have no route, and
  // stay a 404. (Both servers route an http or https absolute-form target by
  // its path, so that one arrives here as a path.)
  private refuseTargetWithoutSlash(path: string, res: HttpResponse): boolean {
    if (path === '*' || path.includes('://') || res.headersSent) return false;
    res.status(400).json({ success: false, error: 'Bad request' });
    return true;
  }

  /**
   * The registered route template a request would dispatch to ('/users/:id'),
   * or undefined when nothing matches. A read-only probe of the same static
   * map and radix tree handleRequest uses: nothing executes and params are not
   * written to the request. Observability middleware needs it for the
   * bounded-cardinality http.route attribute, where the raw path is unbounded.
   */
  matchRoute(method: string, path: string): string | undefined {
    const upper = UPPERCASE_METHODS.has(method) ? method : method.toUpperCase();
    const staticRoute = this.staticRoutesByMethod.get(upper)?.get(path);
    if (staticRoute !== undefined) return staticRoute.schema.path;
    const dynamic = this.radixRouter.findRoute(upper, path);
    return dynamic ? (dynamic.handler as InternalRoute).schema.path : undefined;
  }

  // ===== Route Execution =====

  // A route with middleware, run synchronously for as long as it is
  // synchronous. Each phase and the handler report either "done" (undefined)
  // or the promise they are waiting on; the first promise hands the rest of
  // the route to resumeRoute, and until then nothing is allocated for the
  // sake of asynchrony. A route whose middleware and handler all return
  // plain values therefore answers inside the dispatch call: no async
  // function, no await, and the response is ended before the server would
  // have had to track the request as in flight. It used to cost three async
  // functions and four awaits whatever the route did, because a route with
  // any middleware at all took the async path.
  //
  // true when the route completed synchronously, else a promise of true.
  private runRoute(
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse,
    params: Record<string, string>
  ): boolean | Promise<boolean> {
    const pending = this.executeRoute(route, req, res, params);
    return pending === undefined ? true : pending.then(routeDone);
  }

  private executeRoute(
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse,
    params: Record<string, string>
  ): void | Promise<void> {
    // The matcher already built a fresh params object - use it directly.
    // (No pooling: handlers may retain req past the response, so recycling
    // the object would alias params across requests.)
    req.params = params;

    try {
      // Execute middleware phases in order (most routes have none or few)
      const order = route.executionOrder;
      for (let i = 0; i < order.length; i++) {
        if (res.headersSent) break;
        const pending = this.executePhase(order[i] as string, route, req, res);
        if (pending !== undefined) return this.resumeRoute(pending, i + 1, route, req, res);
      }
      const pending = this.executeHandler(route, req, res);
      if (pending !== undefined) {
        return pending.then(undefined, error => this.routeFailed(error, route, req, res));
      }
    } catch (error) {
      return this.routeFailed(error, route, req, res);
    }
  }

  // The rest of a route from the first phase that went asynchronous.
  private async resumeRoute(
    pending: Promise<unknown>,
    next: number,
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    try {
      await pending;
      const order = route.executionOrder;
      for (let i = next; i < order.length; i++) {
        if (res.headersSent) break;
        const phase = this.executePhase(order[i] as string, route, req, res);
        if (phase !== undefined) await phase;
      }
      const handler = this.executeHandler(route, req, res);
      if (handler !== undefined) await handler;
    } catch (error) {
      await this.routeFailed(error, route, req, res);
    }
  }

  // The handler, and its return value as the JSON reply when it did not
  // answer itself. undefined when all of that happened synchronously.
  private executeHandler(
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    if (res.headersSent) {
      // Headers already sent by middleware (e.g., cache hit, validation error, rate limit, auth)
      // This is expected behavior, not an error
      logger.debug('Handler skipped - response already sent by middleware', 'Execution');
      return;
    }
    const result: any = route.schema.handler(req, res);
    if (result && typeof result.then === 'function') {
      return (result as Promise<any>).then(value => this.sendResult(value, res));
    }
    return this.sendResult(result, res);
  }

  private sendResult(result: any, res: HttpResponse): void | Promise<void> {
    if (result === undefined || res.headersSent) return;
    const sent: any = res.json(result);
    if (sent && typeof sent.then === 'function') return sent as Promise<void>;
  }

  private async routeFailed(
    error: unknown,
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    logger.error('Route execution error', 'Execution', {
      error: error instanceof Error ? error.message : String(error),
      route: `${route.schema.method} ${route.schema.path}`,
    });

    const handled = await this.invokeErrorHandler(error, req, res);
    if (!handled) {
      answerRouteFailure(res, {
        success: false,
        error: 'Internal server error',
        requestId: req.requestId,
      });
    }
  }

  // One phase of a route. undefined when it completed synchronously, else
  // the promise it is waiting on. A phase that answered the request is seen
  // by the caller through res.headersSent.
  private executePhase(
    phase: string,
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<unknown> {
    const schema = route.schema;
    const middleware = schema.middleware;

    switch (phase) {
      case 'before':
        // Performance: Early exit if no middleware present (fast path)
        if (!middleware || !('before' in middleware)) return;
        return this.executeMiddlewareList((middleware as MiddlewarePhases).before, req, res);

      case 'rateLimit':
        // Use Core directly for route-based rate limiting
        if (route.rateLimitConfig) {
          // The route's own pattern is the counter's name: handing it over
          // saves the limiter matching the request against the router again.
          return pendingOf(
            (this.rateLimitCore ??= new RateLimitCore()).checkLimit(
              req,
              res,
              route.rateLimitConfig,
              route.schema.path
            )
          );
        }
        return;

      case 'auth':
        // Auth uses middleware (from requireAuth helper) - created lazily
        if (schema.auth) {
          if (!route.authMiddleware) {
            route.authMiddleware = requireAuth({
              ...(schema.auth.roles !== undefined && { roles: schema.auth.roles }),
              ...(schema.auth.permissions !== undefined && {
                permissions: schema.auth.permissions,
              }),
              ...(schema.auth.optional !== undefined && {
                allowUnauthenticated: schema.auth.optional,
              }),
            });
          }
          if (route.authValidator !== undefined) {
            return this.executeAuthWithValidator(route, schema.auth, req, res);
          }
          return this.executeMiddleware(route.authMiddleware, req, res);
        }
        return;

      case 'validation':
        // Use Core directly for route-based validation. A failed validation
        // has already answered; the caller sees that through headersSent.
        if (route.validationConfig) {
          return pendingOf(validationCore.validate(req, res, route.validationConfig));
        }
        return;

      case 'transform':
        if (!middleware || !('transform' in middleware)) return;
        return this.executeMiddlewareList((middleware as MiddlewarePhases).transform, req, res);

      case 'cache':
        // Use Core directly for route-based caching. A cache hit has already
        // answered; the caller sees that through headersSent.
        if (route.cacheConfig) {
          return pendingOf(this.cacheCore.tryGet(req, res, route.cacheConfig));
        }
        return;

      case 'after':
        if (!middleware || !('after' in middleware)) return;
        return this.executeMiddlewareList((middleware as MiddlewarePhases).after, req, res);

      case 'middleware':
        // Handle array-style middleware (backward compatibility)
        if (!middleware || !Array.isArray(middleware)) return;
        return this.executeMiddlewareList(middleware as Middleware[], req, res);
    }
  }

  // The auth phase of a route that declares a validator: the sign-in, role
  // and permission checks first, then the validator for a request that
  // passed them. With no auth middleware installed (no req.auth) and nothing
  // but the validator to check, the validator is the whole check.
  private executeAuthWithValidator(
    route: InternalRoute,
    auth: AuthConfig,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    if ((req.auth === undefined || req.auth === null) && route.authValidatorOnly) {
      return runAuthValidator(auth, req, res);
    }
    const pending = this.executeMiddleware(route.authMiddleware as Middleware, req, res);
    if (pending) {
      return pending.then(() => {
        if (!res.headersSent) return runAuthValidator(auth, req, res);
      });
    }
    if (res.headersSent) return;
    return runAuthValidator(auth, req, res);
  }

  /**
   * Everything a registered route runs before its handler - rate limit, auth,
   * validation, its middleware, cache - in the order handleRequest runs them,
   * for a caller that reaches the handler without going through handleRequest
   * (the server's direct-route table). The caller checks res.headersSent
   * afterwards; a next(err) or a throw surfaces as a throw / rejection.
   */
  runRoutePhases(
    registered: RegisteredRoute,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    const route = registered as InternalRoute;
    const order = route.executionOrder;
    for (let i = 0; i < order.length; i++) {
      if (res.headersSent) return;
      const pending = this.executePhase(order[i] as string, route, req, res);
      if (pending !== undefined) return this.resumeRoutePhases(pending, i + 1, route, req, res);
    }
  }

  private async resumeRoutePhases(
    pending: Promise<unknown>,
    next: number,
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    await pending;
    const order = route.executionOrder;
    for (let i = next; i < order.length; i++) {
      if (res.headersSent) return;
      const phase = this.executePhase(order[i] as string, route, req, res);
      if (phase !== undefined) await phase;
    }
  }

  /**
   * Run a route's middleware list with the router's own semantics, for a caller
   * that reaches the handler without going through handleRequest (the server's
   * direct-route table). The caller checks res.headersSent afterwards; a
   * next(err) or a throw surfaces as a throw / rejection.
   */
  runMiddleware(
    list: readonly Middleware[] | undefined,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    return this.executeMiddlewareList(list, req, res);
  }

  // A list of middleware in order, stopping once one of them has answered.
  // Synchronous until one returns a promise; the rest then run behind it.
  private executeMiddlewareList(
    list: readonly Middleware[] | undefined,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const pending = this.executeMiddleware(list[i] as Middleware, req, res);
      if (pending) return this.resumeMiddlewareList(pending, list, i + 1, req, res);
      if (res.headersSent) return;
    }
  }

  private async resumeMiddlewareList(
    pending: Promise<void>,
    list: readonly Middleware[],
    next: number,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    await pending;
    if (res.headersSent) return;
    for (let i = next; i < list.length; i++) {
      const r = this.executeMiddleware(list[i] as Middleware, req, res);
      if (r) await r;
      if (res.headersSent) return;
    }
  }

  // Sync-aware: a middleware that returns a non-thenable always settled before
  // the caller could await it (next() called, or the auto-advance below), so
  // the promise was pure overhead - one allocation plus an async suspension per
  // middleware per request. Returns undefined in that case; callers skip the
  // await. A promise is only built when the middleware is genuinely async.
  // Error/advance semantics are unchanged.
  private executeMiddleware(
    middleware: Middleware,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    let resolved = false;
    // An error handed to next(err). The standard (req, res, next) contract:
    // next(err) aborts the chain and goes to the error path - it must never
    // advance to the handler, since that is how a guard denies a request.
    let nextError: unknown;
    let hasNextError = false;
    let settle: (() => void) | undefined;
    let fail: ((reason: unknown) => void) | undefined;

    const next = (err?: unknown) => {
      if (resolved) return;
      resolved = true;
      if (isNextError(err)) {
        hasNextError = true;
        nextError = err;
        if (fail) fail(err);
        return;
      }
      if (settle) settle();
    };

    let result: any;
    try {
      result = middleware(req, res, next);
    } catch (error) {
      // Matches the previous promise form: a throw after next() already
      // advanced the chain was swallowed; otherwise it rejects/throws.
      if (resolved && !hasNextError) return;
      resolved = true;
      throw hasNextError ? nextError : error;
    }

    // Duck typing faster than instanceof
    const isThenable = result && typeof result.then === 'function';

    if (!isThenable) {
      // next(err) called synchronously: abort exactly as a synchronous throw would.
      if (hasNextError) throw nextError;
      // Sync middleware: previously this either resolved via next() or was
      // auto-advanced - settled either way before any await could observe it.
      next();
      return;
    }

    if (resolved) {
      // next() ran synchronously, so the chain already advanced. Keep the
      // returned promise's rejection handled, exactly as the old .catch(reject)
      // did on an already-resolved promise, so it never surfaces as unhandled.
      (result as Promise<any>).then(undefined, () => {});
      if (hasNextError) throw nextError;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
      (result as Promise<any>).then(() => next(), reject);
    });
  }

  // ===== Helper Methods =====

  private isFastPathRoute(schema: RouteSchema): boolean {
    const middleware = schema.middleware;
    const hasMiddleware =
      (middleware && Array.isArray(middleware) && middleware.length > 0) ||
      (middleware &&
        typeof middleware === 'object' &&
        ((middleware as MiddlewarePhases).before?.length ||
          (middleware as MiddlewarePhases).after?.length ||
          (middleware as MiddlewarePhases).transform?.length));

    return (
      !schema.auth && !schema.validation && !schema.rateLimit && !schema.cache && !hasMiddleware
    );
  }

  private buildExecutionOrder(schema: RouteSchema): string[] {
    const order: string[] = [];
    const middleware = schema.middleware;

    // Phase-based middleware
    if (middleware && 'before' in middleware && middleware.before?.length) {
      order.push('before');
    }

    if (schema.rateLimit) order.push('rateLimit');
    if (schema.auth) order.push('auth');
    if (schema.validation) order.push('validation');

    if (middleware && 'transform' in middleware && middleware.transform?.length) {
      order.push('transform');
    }

    if (middleware && 'after' in middleware && middleware.after?.length) {
      order.push('after');
    }

    // Array-style middleware (backward compatibility)
    if (middleware && Array.isArray(middleware) && middleware.length > 0) {
      order.push('middleware');
    }

    // The cache comes last, after every guard the route declares: .use() and
    // .after() middleware and the array form can deny a request, and a stored
    // response is only for a request they let through.
    if (schema.cache) order.push('cache');

    return order;
  }

  // ===== Inspection Methods =====

  getAllRoutes(): RouteSchema[] {
    return this.allRoutes.map(r => r.schema);
  }

  getRouteCount(): number {
    return this.stats.totalRoutes;
  }

  getStats() {
    // Manually build object instead of spread operator
    return {
      totalRoutes: this.stats.totalRoutes,
      staticRoutes: this.stats.staticRoutes,
      dynamicRoutes: this.stats.dynamicRoutes,
      fastPathRoutes: this.stats.fastPathRoutes,
      requestCount: this.stats.requestCount,
      fastPathHits: this.stats.fastPathHits,
      staticHits: this.stats.staticHits,
      dynamicHits: this.stats.dynamicHits,
      cacheHits: this.stats.cacheHits,
      radixHits: this.stats.radixHits,
      poolManager: this.poolManager.getPerformanceSummary(),
      pathMatcher: PathMatcher.getStats(),
    };
  }

  logPerformanceStats(): void {
    const stats = this.getStats();
    logger.info('UnifiedRouter Performance', 'Stats', {
      totalRoutes: stats.totalRoutes,
      staticRoutes: stats.staticRoutes,
      dynamicRoutes: stats.dynamicRoutes,
      fastPathRoutes: stats.fastPathRoutes,
      requests: stats.requestCount,
      poolManager: {
        routeCacheHitRate: stats.poolManager.routeCacheHitRate.toFixed(1) + '%',
        responseCacheHitRate: stats.poolManager.responseCacheHitRate.toFixed(1) + '%',
        paramPoolUtilization: stats.poolManager.paramPoolUtilization.toFixed(1) + '%',
        totalMemoryKB: stats.poolManager.totalMemoryKB.toFixed(1) + ' KB',
      },
    });
  }
}
