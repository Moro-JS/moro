import type { Middleware } from '../../../../types/http.js';

/**
 * JSON body-parser middleware. MoroJS auto-parses JSON bodies on POST/PUT/PATCH
 * requests upstream, so this middleware is effectively a pass-through. It exists
 * so code written in the `app.use(json())` idiom works verbatim without rewrites.
 */
export function json(_options?: { limit?: number | string; strict?: boolean }): Middleware {
  return function moroJsonBodyParser(_req, _res, next) {
    next();
  };
}

/**
 * URL-encoded body-parser middleware. Parses `application/x-www-form-urlencoded`
 * request bodies when the automatic parser left them as strings, populating
 * `req.body` with the decoded object.
 */
export function urlencoded(_options?: { extended?: boolean; limit?: number | string }): Middleware {
  return function moroUrlencodedBodyParser(req, _res, next) {
    const ct = (req.headers['content-type'] || '') as string;
    if (!ct.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return next();
    }
    if (typeof req.body === 'string') {
      const parsed: Record<string, string> = {};
      const pairs = req.body.split('&');
      for (const pair of pairs) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const k = eq === -1 ? pair : pair.substring(0, eq);
        const v = eq === -1 ? '' : pair.substring(eq + 1);
        parsed[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(
          v.replace(/\+/g, ' ')
        );
      }
      req.body = parsed;
    }
    next();
  };
}
