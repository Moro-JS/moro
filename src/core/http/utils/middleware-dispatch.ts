// The app.use() / route middleware chain shared by the Node http server, the
// HTTP/2 server and the native engine server, so a guard behaves the same
// whichever one is serving.
//
// Express-compatible error propagation: a function declared with four
// parameters, (err, req, res, next), is an error middleware and runs only
// while an error is active; next(err) and a throw (or a rejected promise) make
// the error active and skip forward to the next error middleware. An error
// still active at the end of the chain is thrown to the caller, which answers
// through the server's error path.
//
// Sync-aware dispatch: middleware that calls next() synchronously (or throws
// synchronously) advances the chain in a plain loop with ZERO promise
// allocations. A promise is only created when a middleware actually completes
// asynchronously. Returns undefined when the whole chain ran synchronously.
import type { HttpRequest, HttpResponse, Middleware } from '../../../types/http.js';

// What a three-parameter middleware means when it returns having neither
// called next() nor returned a promise. Every server waits for its next();
// they differ in what a caller needs once the middleware has answered:

/** Wait for its next(): it will call it later, from a callback (Node http server). */
export const WAIT_FOR_NEXT = 0;
/** Move on to the next middleware at once (no server uses it). */
export const ADVANCE_ON_RETURN = 1;
/**
 * Wait for its next() unless it has answered the request, in which case the
 * chain is over and nothing is allocated to wait on (the native engine
 * server, the HTTP/2 server and the serverless runtimes, whose callers look
 * at res.headersSent when the chain returns).
 */
export const WAIT_UNLESS_ANSWERED = 2;

/**
 * Run `middleware` from `startIndex`, with `initialError` active when given.
 * `onReturn` is one of the three constants above; an error middleware is
 * never moved past (ADVANCE_ON_RETURN applies to three-parameter middleware).
 *
 * What next() is called with follows the standard (req, res, next) contract,
 * the same one route-level middleware follows: any truthy argument is an
 * error, except the 'route' / 'router' skip tokens; a falsy one (next(),
 * next(null)) is a plain advance, so next can be handed to a Node-style
 * callback API.
 */
export function dispatchMiddleware(
  middleware: Middleware[],
  req: HttpRequest,
  res: HttpResponse,
  startIndex: number,
  initialError: any,
  onReturn: number
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
      const error = err && err !== 'route' && err !== 'router' ? err : undefined;
      settledError = error;
      if (asyncResolve) asyncResolve(error);
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
      if (onReturn === ADVANCE_ON_RETURN && !isErrorHandler) {
        // Treated as done. A next() it calls later finds the chain already
        // past it and does nothing.
        settled = true;
        continue;
      }
      if (onReturn === WAIT_UNLESS_ANSWERED && res.headersSent) {
        // Terminal middleware (Express style): it answered the request and
        // deliberately never calls next(). The chain is finished - skip
        // allocating a promise that nothing would ever settle.
        return;
      }
      // Sync-looking middleware that neither called next() nor returned a
      // promise: it will call next() later (e.g. from an event callback).
      // Fall back to a promise for the remainder of the chain.
      const resumeIndex = i;
      return new Promise<any>(resolve => {
        asyncResolve = resolve;
      }).then(err => dispatchMiddleware(middleware, req, res, resumeIndex, err, onReturn));
    }

    // Async middleware: completion is next() OR promise settle, whichever
    // happens first (same semantics as the previous implementation).
    const resumeIndex = i;
    return new Promise<any>(resolve => {
      asyncResolve = resolve;
      // A rejection is an error whatever its reason; only next()'s argument
      // goes through the contract above.
      (result as Promise<void>).then(
        () => {
          if (!settled) {
            settled = true;
            resolve(undefined);
          }
        },
        (err: any) => {
          if (!settled) {
            settled = true;
            resolve(err);
          }
        }
      );
    }).then(err => dispatchMiddleware(middleware, req, res, resumeIndex, err, onReturn));
  }

  // If an error is still unhandled after the chain, re-throw so the server's
  // error path can invoke the registered error handler / default 500.
  if (activeError !== undefined) {
    throw activeError;
  }
}
