import type { HttpResponse, Middleware } from '../../../../types/http.js';
import { isJsonMediaType } from '../../../http/utils/body-type.js';
import { isValidSize, parseSizeToBytes } from '../../../http/utils/size.js';
import { requestBodyBytes } from '../body-size/core.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('BodyParsers');

/**
 * The parser's `limit` in bytes, or undefined when none was passed. MoroJS has
 * read (and parsed) the body before any middleware runs, under
 * `server.bodySizeLimit`; the parser's own limit is applied to that body when
 * the middleware runs, for the content types the parser handles. A value that
 * cannot be read as a size is reported once, when the parser is created, and
 * not applied.
 */
function resolveLimit(parser: string, options?: { limit?: number | string }): number | undefined {
  const limit = options?.limit;
  if (limit === undefined || limit === null) return undefined;
  const readable =
    typeof limit === 'number' ? Number.isFinite(limit) && limit >= 0 : isValidSize(limit);
  if (!readable) {
    logger.warn(
      `${parser}({ limit: ${JSON.stringify(limit)} }) cannot be read as a size and is not applied. ` +
        `Use a number of bytes or a string such as '100kb' or '1mb'.`,
      'BodyParsers'
    );
    return undefined;
  }
  return parseSizeToBytes(typeof limit === 'string' ? limit.trim() : limit);
}

// The answer the server gives a body over `server.bodySizeLimit`
function rejectTooLarge(res: HttpResponse): void {
  res.status(413).json({ success: false, error: 'Request entity too large' });
}

/**
 * JSON body-parser middleware. MoroJS auto-parses JSON bodies on POST/PUT/PATCH
 * requests upstream, so without options this middleware is a pass-through. It
 * exists so code written in the `app.use(json())` idiom works verbatim without
 * rewrites. With `limit`, a JSON body larger than that is answered 413.
 */
export function json(_options?: { limit?: number | string; strict?: boolean }): Middleware {
  const limit = resolveLimit('json', _options);
  if (limit === undefined) {
    return function moroJsonBodyParser(_req, _res, next) {
      next();
    };
  }
  return function moroJsonBodyParser(req, res, next) {
    if (isJsonMediaType(req.headers['content-type']) && requestBodyBytes(req) > limit) {
      rejectTooLarge(res);
      return;
    }
    next();
  };
}

/**
 * URL-encoded body-parser middleware. Parses `application/x-www-form-urlencoded`
 * request bodies when the automatic parser left them as strings, populating
 * `req.body` with the decoded object. With `limit`, a form body larger than
 * that is answered 413.
 */
export function urlencoded(_options?: { extended?: boolean; limit?: number | string }): Middleware {
  const limit = resolveLimit('urlencoded', _options);
  return function moroUrlencodedBodyParser(req, res, next) {
    const ct = (req.headers['content-type'] || '') as string;
    if (!ct.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return next();
    }
    if (limit !== undefined && requestBodyBytes(req) > limit) {
      rejectTooLarge(res);
      return;
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
 * With `limit`, a matching body larger than that is answered 413.
 */
export function raw(options?: { type?: string | string[]; limit?: number | string }): Middleware {
  const limit = resolveLimit('raw', options);
  const wanted = options?.type ?? 'application/octet-stream';
  return function moroRawBodyParser(req, res, next) {
    const ct = (req.headers['content-type'] || '') as string;
    if (limit !== undefined && typeMatches(ct, wanted) && requestBodyBytes(req) > limit) {
      rejectTooLarge(res);
      return;
    }
    if (typeof req.body === 'string' && typeMatches(ct, wanted)) {
      req.body = req.rawBody ?? Buffer.from(req.body, 'utf8');
    }
    next();
  };
}

/**
 * Text body-parser middleware (Express `text()` idiom): decodes a Buffer body
 * to a UTF-8 string for the matching content types (default `text/plain`).
 * With `limit`, a matching body larger than that is answered 413.
 */
export function text(options?: { type?: string | string[]; limit?: number | string }): Middleware {
  const limit = resolveLimit('text', options);
  const wanted = options?.type ?? 'text/plain';
  return function moroTextBodyParser(req, res, next) {
    const ct = (req.headers['content-type'] || '') as string;
    if (limit !== undefined && typeMatches(ct, wanted) && requestBodyBytes(req) > limit) {
      rejectTooLarge(res);
      return;
    }
    if (Buffer.isBuffer(req.body) && typeMatches(ct, wanted)) {
      req.body = req.body.toString('utf8');
    }
    next();
  };
}
