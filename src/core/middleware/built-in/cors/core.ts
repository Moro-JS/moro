// CORS Core - Reusable CORS logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('CORSCore');

// ===== Types =====

export type OriginFunction = (
  origin: string | undefined,
  req: HttpRequest
) => string | string[] | boolean | Promise<string | string[] | boolean>;

export interface CORSOptions {
  origin?: string | string[] | boolean | OriginFunction;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  exposedHeaders?: string[];
  preflightContinue?: boolean;
}

/** Add `Origin` to the response's Vary header, keeping what is already there. */
function appendVaryOrigin(res: HttpResponse): void {
  const current = typeof res.getHeader === 'function' ? res.getHeader('Vary') : undefined;
  const existing = Array.isArray(current) ? current.join(', ') : current ? String(current) : '';
  if (!existing) {
    res.setHeader('Vary', 'Origin');
  } else if (existing !== '*' && !/(?:^|,)\s*origin\s*(?:,|$)/i.test(existing)) {
    res.setHeader('Vary', `${existing}, Origin`);
  }
}

// ===== Core Logic =====

/**
 * CORSCore - Core CORS header management logic
 * Used directly by the router for route-based CORS
 * Can be instantiated for use in middleware or hooks
 */
export class CORSCore {
  private options: CORSOptions;
  private cachedMethods: string;
  private cachedAllowedHeaders: string;
  private wildcardCredentialsWarned = false;

  constructor(options: CORSOptions = {}) {
    this.options = {
      origin: '*',
      methods: 'GET,POST,PUT,DELETE,OPTIONS',
      allowedHeaders: 'Content-Type,Authorization',
      credentials: false,
      ...options,
    };
    this.cachedMethods = Array.isArray(this.options.methods)
      ? this.options.methods.join(',')
      : this.options.methods || 'GET,POST,PUT,DELETE,OPTIONS';
    this.cachedAllowedHeaders = Array.isArray(this.options.allowedHeaders)
      ? this.options.allowedHeaders.join(',')
      : this.options.allowedHeaders || 'Content-Type,Authorization';
  }

  /**
   * Apply CORS headers to response
   * Now supports async origin validation
   */
  async applyCORS(res: HttpResponse, req: HttpRequest): Promise<boolean> {
    // Origin - handle function, array, string, or boolean
    let resolvedOrigin: string | string[] | boolean | null | undefined = '*';

    if (typeof this.options.origin === 'function') {
      const requestOrigin = (req.headers as any).origin || (req.headers as any).Origin;
      resolvedOrigin = await this.options.origin(requestOrigin, req);
    } else if (this.options.origin !== undefined) {
      resolvedOrigin = this.options.origin;
    }

    // The allowed origin is chosen per request when it comes from a function,
    // or from a list that is matched against the request's Origin.
    const perRequest = typeof this.options.origin === 'function' || Array.isArray(resolvedOrigin);

    // If origin function returned false, deny the request
    if (resolvedOrigin === false) {
      return false;
    }

    // An origin function that answers with nothing (typically: it echoed an
    // Origin the request did not send) names no origin: the request goes on
    // without CORS headers, instead of with the literal text "undefined".
    if (resolvedOrigin === undefined || resolvedOrigin === null) {
      return true;
    }

    // Convert true to wildcard
    if (resolvedOrigin === true) {
      resolvedOrigin = '*';
    }

    // Access-Control-Allow-Origin carries exactly one origin (or '*'): a list
    // is matched against the request's Origin and only the match is sent. A
    // request whose Origin is not in the list (or that sends none) is named
    // no origin at all - never another origin's.
    let originHeader: string | undefined;
    if (Array.isArray(resolvedOrigin)) {
      const requestOrigin = (req.headers as any).origin || (req.headers as any).Origin;
      if (requestOrigin && resolvedOrigin.includes(requestOrigin)) {
        originHeader = requestOrigin;
      } else if (requestOrigin && this.options.credentials) {
        // Request origin not in allowed list - deny
        return false;
      }
    } else {
      originHeader = String(resolvedOrigin);
    }

    // A response whose CORS answer depends on the request's Origin must not
    // be replayed by a shared cache to a different origin: say so with
    // `Vary: Origin`, also when no origin was named. A wildcard answer is the
    // same for every origin and needs none, so requests that carry no Origin
    // pay nothing here.
    if (perRequest && originHeader !== '*') {
      appendVaryOrigin(res);
    }

    if (originHeader !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
    }

    // Methods
    res.setHeader('Access-Control-Allow-Methods', this.cachedMethods);

    // Headers
    res.setHeader('Access-Control-Allow-Headers', this.cachedAllowedHeaders);

    // Credentials — guard against invalid credentials + wildcard combination (CORS spec violation)
    if (this.options.credentials && originHeader !== undefined) {
      if (originHeader === '*') {
        if (!this.wildcardCredentialsWarned) {
          this.wildcardCredentialsWarned = true;
          logger.warn(
            '[MoroJS Security] CORS credentials:true with origin:* is a spec violation — browsers will reject this. ' +
              'Forcing credentials:false. Configure specific allowed origins for credential support.',
            'CORSCore'
          );
        }
      } else {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }

    // Max Age
    if (this.options.maxAge) {
      res.setHeader('Access-Control-Max-Age', String(this.options.maxAge));
    }

    // Exposed Headers
    if (this.options.exposedHeaders && this.options.exposedHeaders.length > 0) {
      res.setHeader('Access-Control-Expose-Headers', this.options.exposedHeaders.join(','));
    }

    return true;
  }

  /**
   * Whether `req` is a preflight this CORS answers itself (204, or 403 for an
   * origin it refuses): an OPTIONS request that names the method it asks
   * about, unless `preflightContinue` leaves it to the application.
   */
  /** Whether this CORS has already put its headers on `res`. */
  appliedTo(res: HttpResponse): boolean {
    return (
      typeof res.getHeader === 'function' &&
      res.getHeader('Access-Control-Allow-Methods') === this.cachedMethods
    );
  }

  answersPreflight(req: HttpRequest): boolean {
    return (
      req.method === 'OPTIONS' &&
      !this.options.preflightContinue &&
      !!(req.headers as Record<string, unknown> | undefined)?.['access-control-request-method']
    );
  }
}

// ===== The application's CORS, for a response answered ahead of it =====

// The CORSCore behind a CORS middleware function, so that code which answers
// a request before function middleware runs can find it.
const kCORSCore: unique symbol = Symbol('moro.cors.core');

// The CORSCore of each CORS installed as a hook, by the hook manager it was
// installed on (the one its server runs).
const hookCORS = new WeakMap<object, CORSCore[]>();

/** Mark `middleware` as the CORS middleware that applies `core`'s headers. */
export function tagCORSMiddleware<T extends object>(middleware: T, core: CORSCore): T {
  Object.defineProperty(middleware, kCORSCore, { value: core });
  return middleware;
}

/** Record that `core` is installed as a hook on `hooks`. */
export function registerCORSHook(hooks: object, core: CORSCore): void {
  const cores = hookCORS.get(hooks);
  if (cores) cores.push(core);
  else hookCORS.set(hooks, [core]);
}

// Every CORS in front of the routes of the server that owns `res`: the ones
// registered as global middleware (security.cors, app.use(fn)) and the ones
// installed as a hook (app.use(middleware.cors())).
function globalCORS(res: HttpResponse): CORSCore[] {
  const server = (res as any)?._server;
  const found: CORSCore[] = [];
  if (!server) return found;
  const registered: unknown = server.globalMiddleware;
  if (Array.isArray(registered)) {
    for (let i = 0; i < registered.length; i++) {
      const entry = registered[i];
      const core: CORSCore | undefined =
        typeof entry === 'function' ? (entry as any)[kCORSCore] : undefined;
      if (core !== undefined) found.push(core);
    }
  }
  const hooks: unknown = server.hookManager;
  const hooked = hooks !== null && typeof hooks === 'object' ? hookCORS.get(hooks) : undefined;
  if (hooked) found.push(...hooked);
  return found;
}

/**
 * Give a response that a hook answers (the rate limiter's 429, the CSRF
 * check's 403) the headers the application's CORS gives every other response
 * to the same request: the same origin decision, credentials, exposed headers
 * and `Vary: Origin`. Hooks run before function middleware, and a hook may be
 * registered ahead of the CORS hook, so such a response would otherwise leave
 * without them and a page on an allowed origin would see an opaque network
 * error. An origin the application does not allow is named none. Does nothing
 * when the application has no CORS, or when its CORS has already run for this
 * request.
 */
export async function applyGlobalCORS(req: HttpRequest, res: HttpResponse): Promise<void> {
  if ((res as any).headersSent) return;
  const cores = globalCORS(res);
  for (let i = 0; i < cores.length; i++) {
    const core = cores[i] as CORSCore;
    if (core.appliedTo(res)) continue;
    try {
      await core.applyCORS(res, req);
    } catch {
      // An origin function that failed has named no origin. The answer being
      // sent is somebody else's refusal: it leaves as it is, without CORS
      // headers, instead of becoming a 500.
    }
  }
}

/**
 * Whether `req` is a preflight that the application's CORS answers itself.
 * The rate limiter and the CSRF check leave such a request to it: it is
 * neither counted nor asked for a token, wherever CORS is registered.
 */
export function globalCORSAnswersPreflight(req: HttpRequest, res: HttpResponse): boolean {
  if (!req || req.method !== 'OPTIONS') return false;
  const cores = globalCORS(res);
  for (let i = 0; i < cores.length; i++) {
    if ((cores[i] as CORSCore).answersPreflight(req)) return true;
  }
  return false;
}
