// The strict contract for route and module middleware, switched on with
// `routing.strictMiddleware`. By default a route's middleware is done when it
// returns, or when the promise it returns settles: the request goes on to the
// handler whether or not next() was called. With the switch on, a middleware
// declared with three parameters, (req, res, next), lets the request go on
// only by calling next(), now or later from a callback, as in Express. One
// that never calls it and never answers leaves the request waiting, and is
// named in the log; an async one that finished without either has nowhere
// left to call next() from, and the request is answered with a 500.
//
// The switch is applied where routes are registered: a three-parameter
// middleware is replaced by the wrapper below, which speaks the protocol the
// router and the module pipeline already have. With the switch off nothing
// here runs, at registration or per request.
import { createFrameworkLogger } from '../logger/index.js';
import type { HttpRequest, HttpResponse } from '../../types/http.js';
import { clearRepresentationHeaders } from '../http/utils/response-headers.js';

const logger = createFrameworkLogger('Middleware');

const STRICT = Symbol('moro.strictMiddleware');
// Marks of a factory handed over uncalled (requireAuth instead of
// requireAuth()). Those are reported where they are found; wrapping one
// would hide the mark.
const GUARD_FACTORY = Symbol.for('morojs.guard-factory');
const MIDDLEWARE_FACTORY = Symbol.for('morojs.middleware-factory');

type NextFunction = (err?: unknown) => void;
type RouteMiddleware = (req: HttpRequest, res: HttpResponse, next: NextFunction) => unknown;

/** Whether the app configuration asks for the strict middleware contract. */
export function isStrictMiddlewareEnabled(config: { routing?: unknown } | undefined): boolean {
  const routing = config?.routing;
  return (
    typeof routing === 'object' &&
    routing !== null &&
    (routing as { strictMiddleware?: unknown }).strictMiddleware === true
  );
}

// Answer for an async middleware whose promise resolved without next() and
// without a response. One line in the log names it; the client gets the 500
// a failed route gets. A response that cannot be answered here fails the
// request through the error path instead, so it still does not reach the
// handler.
function refuse(
  req: HttpRequest,
  res: HttpResponse,
  name: string,
  route: string | undefined
): void {
  const message =
    `Middleware ${name} on ${route ?? `${req.method} ${req.path}`} finished without calling ` +
    `next() and without sending a response. With routing.strictMiddleware the request is not ` +
    `passed on: it was answered with 500. Call next() to continue, or answer the request.`;
  logger.error(message, 'StrictMiddleware');
  if (!res.headersSent) {
    clearRepresentationHeaders(res);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      requestId: req.requestId,
    });
  }
  if (!res.headersSent) throw new Error(message);
}

// How long a middleware that returned without next() and without a response
// is waited for before the log says so
const NEXT_WARNING_MS = 30000;

// What the wrapper uses of a response that can tell when it is over
interface ResponseEvents {
  once?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
  answeredOr?(pending: Promise<void>): Promise<void>;
}

// A middleware returned without next() and without a response: it will call
// next() later, from a callback. The promise settles when it does (`release`
// is then called by the wrapper), or when the response has been sent by
// then, which ends the chain as an answer always does. One that does neither
// keeps the request waiting, as it would in Express; a single warning after
// NEXT_WARNING_MS says which middleware that is. The timer does not keep the
// process alive and is gone as soon as the wait is over.
function waitForNext(
  req: HttpRequest,
  res: HttpResponse,
  name: string,
  route: string | undefined,
  onRelease: (release: () => void) => void,
  onOver: () => void
): Promise<void> {
  const events = res as unknown as ResponseEvents;
  let finish: () => void = () => {};
  const waiting = new Promise<void>(resolve => {
    finish = resolve;
  });

  const timer = setTimeout(() => {
    logger.warn(
      `Middleware ${name} on ${route ?? `${req.method} ${req.path}`} has not called next() or ` +
        `sent a response ${NEXT_WARNING_MS / 1000} seconds after it returned. With ` +
        `routing.strictMiddleware the request waits for next(): call it, or answer the request.`,
      'StrictMiddleware'
    );
  }, NEXT_WARNING_MS);
  if (typeof timer.unref === 'function') timer.unref();

  const over = (): void => {
    clearTimeout(timer);
    if (typeof events.removeListener === 'function') {
      events.removeListener('finish', over);
      events.removeListener('close', over);
    }
    // From here on a next() has nothing to do. A response that was sent ends
    // the chain; a connection that went away with nothing sent leaves it
    // where it is: nothing more runs for that request.
    onOver();
    if (res.headersSent) finish();
  };
  if (typeof events.once === 'function') {
    events.once('finish', over);
    events.once('close', over);
  }
  onRelease(() => {
    clearTimeout(timer);
    if (typeof events.removeListener === 'function') {
      events.removeListener('finish', over);
      events.removeListener('close', over);
    }
    finish();
  });

  // A response that is handed over whole once the handler has returned
  // (serverless) says it is answered here, not through an event
  return typeof events.answeredOr === 'function' ? events.answeredOr(waiting) : waiting;
}

/**
 * `middleware` under the strict contract, when it is a function declared with
 * three parameters; anything else is returned as it is (a two-parameter
 * function has no next() to call and keeps advancing on return). `position`
 * is its place in the list, used to name one that has no name; `route` names
 * the route in the log, and defaults to the request's method and path.
 *
 * The wrapper advances the chain only through next():
 *   - next() or next(err), whenever it is called - before the middleware
 *     returns, before the promise it returned settles, or later from a
 *     callback: passed on as it is
 *   - the middleware answered the request: the chain ends there, as always
 *   - it returned no promise and has done neither: it is waited for (see
 *     waitForNext)
 *   - the promise it returned resolved and it has done neither: 500, and one
 *     error line in the log. A next() that arrives after that does nothing.
 * A throw or a rejected promise is the error it has always been. A middleware
 * that calls next() before it returns costs no promise and no timer.
 */
export function strictMiddleware<T>(middleware: T, position: number, route?: string): T {
  if (typeof middleware !== 'function' || middleware.length !== 3) return middleware;
  const original = middleware as unknown as RouteMiddleware & Record<symbol, unknown>;
  if (original[STRICT] === true || original[GUARD_FACTORY] || original[MIDDLEWARE_FACTORY]) {
    return middleware;
  }
  const name = original.name ? `'${original.name}'` : `#${position + 1}`;

  const strict = function (req: HttpRequest, res: HttpResponse, next: NextFunction): unknown {
    // 0: waiting for next(), 1: next() was called, 2: refused, 3: the
    // response was sent, or the connection went away, while it was waited for
    let state = 0;
    let release: (() => void) | undefined;
    const advance: NextFunction = err => {
      // Once the request was refused or answered, a next() has nothing to do
      if (state !== 0) return;
      state = 1;
      next(err);
      if (release !== undefined) release();
    };

    const result: any = original(req, res, advance);
    if (state === 1) return result;

    if (result && typeof result.then === 'function') {
      return (result as Promise<unknown>).then(() => {
        if (state !== 0 || res.headersSent) return;
        state = 2;
        refuse(req, res, name, route);
      });
    }

    if (res.headersSent) return undefined;
    return waitForNext(
      req,
      res,
      name,
      route,
      whenReleased => {
        release = whenReleased;
      },
      () => {
        state = 3;
      }
    );
  };
  Object.defineProperty(strict, 'name', { value: original.name, configurable: true });
  (strict as unknown as Record<symbol, unknown>)[STRICT] = true;
  return strict as unknown as T;
}

/** strictMiddleware over a list; the list itself is left as it was. */
export function strictMiddlewareList<T>(
  list: readonly T[] | undefined,
  route?: string
): T[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((entry, position) => strictMiddleware(entry, position, route));
}

/**
 * A route's middleware - a list, or lists by phase (before, after, transform)
 * - with every list under the strict contract.
 */
export function strictRouteMiddleware<T>(middleware: T, route?: string): T {
  if (Array.isArray(middleware)) return strictMiddlewareList(middleware, route) as unknown as T;
  if (middleware === null || typeof middleware !== 'object') return middleware;
  const phases: Record<string, unknown> = {};
  for (const phase of Object.keys(middleware)) {
    const list = (middleware as Record<string, unknown>)[phase];
    phases[phase] = Array.isArray(list) ? strictMiddlewareList(list, route) : list;
  }
  return phases as T;
}

// One wrapper for each middleware that is looked up by name when a request
// arrives, instead of one per request
const resolvedByName = new WeakMap<object, unknown>();

/**
 * strictMiddleware for a middleware a module names by string, which is
 * resolved per request: the same wrapper every time. It is named after the
 * request in the log (its method and path).
 */
export function strictNamedMiddleware<T>(middleware: T): T {
  if (typeof middleware !== 'function') return middleware;
  let strict = resolvedByName.get(middleware) as T | undefined;
  if (strict === undefined) {
    strict = strictMiddleware(middleware, 0);
    resolvedByName.set(middleware, strict);
  }
  return strict;
}
