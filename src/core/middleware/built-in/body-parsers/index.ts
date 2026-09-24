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

function typeMatches(contentType: string, wanted: string | string[]): boolean {
  const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  for (const t of Array.isArray(wanted) ? wanted : [wanted]) {
    const w = t.toLowerCase();
    if (w === '*/*' || w === ct) return true;
    if (w.endsWith('/*') && ct.startsWith(w.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Raw body-parser middleware (Express `raw()` idiom). MoroJS already keeps
 * binary bodies as Buffers, so this only converts a body that was decoded to
 * a string back to its exact bytes for the matching content types (default
 * `application/octet-stream`). `req.rawBody` is always available regardless.
 */
export function raw(options?: { type?: string | string[]; limit?: number | string }): Middleware {
  const wanted = options?.type ?? 'application/octet-stream';
  return function moroRawBodyParser(req, _res, next) {
    const ct = (req.headers['content-type'] || '') as string;
    if (typeof req.body === 'string' && typeMatches(ct, wanted)) {
      req.body = req.rawBody ?? Buffer.from(req.body, 'utf8');
    }
    next();
  };
}

/**
 * Text body-parser middleware (Express `text()` idiom): decodes a Buffer body
 * to a UTF-8 string for the matching content types (default `text/plain`).
 */
export function text(options?: { type?: string | string[]; limit?: number | string }): Middleware {
  const wanted = options?.type ?? 'text/plain';
  return function moroTextBodyParser(req, _res, next) {
    const ct = (req.headers['content-type'] || '') as string;
    if (Buffer.isBuffer(req.body) && typeMatches(ct, wanted)) {
      req.body = req.body.toString('utf8');
    }
    next();
  };
}
