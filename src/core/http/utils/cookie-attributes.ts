// The Set-Cookie serializer, and the checks and conversions behind it, that
// every writer shares (res.cookie() on the Node, HTTP/2 and engine servers
// and on the serverless responses, and the cookie middleware), so a cookie is
// the same bytes wherever it is set.
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('Cookies');

// RFC 6265 cookie-name = RFC 7230 token
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// A host name, optionally with the leading dot older code still writes
const COOKIE_DOMAIN = /^\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?$/;
// RFC 6265 path-value: any character except controls and ';'
// eslint-disable-next-line no-control-regex
const NOT_PATH_SAFE = /[\u0000-\u001f\u007f;]/;

/**
 * Throws unless `name` can be a cookie name. A name is written into the
 * header as it is, so one holding `=`, `;`, a space or a control character
 * would turn into a different cookie or into extra attributes.
 */
export function assertCookieName(name: string): void {
  if (typeof name !== 'string' || !COOKIE_NAME.test(name)) {
    throw new TypeError(
      `Invalid cookie name ${JSON.stringify(name)}: a name may hold letters, digits and ` +
        "!#$%&'*+-.^_`|~ only"
    );
  }
}

// An application sets its cookies with the same one or two domains and
// paths over and over: the value checked last is not checked again.
let lastValidDomain: string | undefined;
let lastValidPath: string | undefined;

/** The `Domain` attribute as given, or a TypeError when it is not a host name. */
export function cookieDomain(domain: unknown): string {
  if (domain === lastValidDomain) return domain as string;
  if (typeof domain !== 'string' || !COOKIE_DOMAIN.test(domain)) {
    throw new TypeError(
      `Invalid cookie domain ${JSON.stringify(domain)}: expected a host name such as "example.com"`
    );
  }
  lastValidDomain = domain;
  return domain;
}

/** The `Path` attribute as given, or a TypeError when it holds `;` or a control character. */
export function cookiePath(path: unknown): string {
  if (path === '/' || path === lastValidPath) return path as string;
  if (typeof path !== 'string' || NOT_PATH_SAFE.test(path)) {
    throw new TypeError(
      `Invalid cookie path ${JSON.stringify(path)}: a path may not hold ";" or control characters`
    );
  }
  lastValidPath = path;
  return path;
}

/**
 * The `SameSite` attribute: 'strict', 'lax' or 'none' in any letter case, as
 * given; `true` means Strict. Anything else is a TypeError.
 */
export function cookieSameSite(sameSite: unknown): string {
  if (sameSite === true) return 'Strict';
  if (typeof sameSite === 'string') {
    if (
      sameSite === 'strict' ||
      sameSite === 'lax' ||
      sameSite === 'none' ||
      sameSite === 'Strict' ||
      sameSite === 'Lax' ||
      sameSite === 'None'
    ) {
      return sameSite;
    }
    const lower = sameSite.toLowerCase();
    if (lower === 'strict' || lower === 'lax' || lower === 'none') return sameSite;
  }
  throw new TypeError(
    `Invalid cookie sameSite ${JSON.stringify(sameSite)}: expected 'strict', 'lax' or 'none'`
  );
}

/** An `Expires` attribute value: a Date, or text that cannot end the attribute. */
export function cookieExpires(expires: unknown): string {
  if (expires instanceof Date) return expires.toUTCString();
  const text = String(expires);
  if (NOT_PATH_SAFE.test(text)) {
    throw new TypeError(`Invalid cookie expires ${JSON.stringify(text)}: expected a Date`);
  }
  return text;
}

let shortMaxAgeWarned = false;

/**
 * `maxAge` is the cookie's lifetime in milliseconds, as in Express; the
 * `Max-Age` attribute counts seconds. Returns the whole seconds to send, or
 * undefined when `maxAge` is not a finite number (the attribute is then left
 * out).
 */
export function maxAgeSeconds(maxAge: unknown): number | undefined {
  const ms = typeof maxAge === 'number' ? maxAge : Number(maxAge);
  if (!Number.isFinite(ms)) return undefined;
  if (ms > 0 && ms < 1000 && !shortMaxAgeWarned) {
    // Almost always a lifetime written in seconds: say so once, because the
    // cookie it produces is dropped by the browser as soon as it arrives.
    shortMaxAgeWarned = true;
    logger.warn(
      `Cookie maxAge is in milliseconds: maxAge: ${ms} is sent as Max-Age=0, which expires the ` +
        `cookie at once. For ${ms} seconds pass ${ms * 1000}.`,
      'CookieWarning'
    );
  }
  return Math.floor(ms / 1000);
}

/**
 * Whether the request arrived over TLS, as far as this server knows: what a
 * cookie's `Secure` attribute follows when the caller gave no `secure`.
 *
 *   - the connection to this server is a TLS connection, or
 *   - `server.trustProxy` is set and a proxy it trusts says the client
 *     reached it over https (`X-Forwarded-Proto: https`). With the setting,
 *     the proxy's word is the answer either way: `req.secure`.
 *
 * `X-Forwarded-Proto` from a peer nobody named as a proxy does not count: any
 * client can send it. A request served by a serverless adapter has no
 * connection here; its response knows what the platform reported (`res`).
 */
export function arrivedOverTls(req: unknown, res?: unknown): boolean {
  const request = req as
    | {
        _server?: { proxyTrust?: unknown; isSsl?: unknown };
        socket?: { encrypted?: unknown };
        secure?: unknown;
      }
    | null
    | undefined;
  if (request !== undefined && request !== null) {
    const server = request._server;
    if (server !== undefined && server !== null) {
      if (server.proxyTrust !== undefined) return request.secure === true;
      // The engine server has one listener, TLS or not, and says which
      if (typeof server.isSsl === 'boolean') return server.isSsl;
    }
    const socket = request.socket;
    if (socket !== undefined && socket !== null) return socket.encrypted === true;
  }
  const response = res as { _overTls?: () => boolean } | null | undefined;
  return response !== undefined && response !== null && typeof response._overTls === 'function'
    ? response._overTls()
    : false;
}

let sameSiteNoneWarned = false;

/**
 * Whether the cookie `name` is written with `Secure`. An explicit `secure`
 * option decides; without one the cookie is `Secure` when the request arrived
 * over TLS (see arrivedOverTls), so a cookie set on an https site is not sent
 * back over plain http, and a cookie set over plain http is as it always was.
 *
 * `SameSite=None` without `Secure` is said once: browsers drop that cookie.
 */
export function cookieIsSecure(
  name: string,
  options: { secure?: unknown; sameSite?: unknown },
  req: unknown,
  res?: unknown
): boolean {
  const given = options.secure;
  const secure = given === undefined || given === null ? arrivedOverTls(req, res) : !!given;
  if (!secure && !sameSiteNoneWarned) {
    const sameSite = options.sameSite;
    if (
      typeof sameSite === 'string' &&
      sameSite.length === 4 &&
      sameSite.toLowerCase() === 'none'
    ) {
      sameSiteNoneWarned = true;
      logger.warn(
        `Cookie '${name}' is set with SameSite=None and without Secure: browsers drop such a ` +
          `cookie. Serve the site over https (behind a proxy, name the proxy in server.trustProxy) ` +
          `or pass secure: true.`,
        'CookieWarning'
      );
    }
  }
  return secure;
}

/**
 * The Set-Cookie value res.cookie(name, value, options) sends: the one
 * serializer behind res.cookie() on the Node, HTTP/2 and engine servers, on
 * the serverless responses and in the cookie middleware, so the same call
 * sends the same bytes wherever it is made.
 *
 * The value is URL-encoded. `maxAge` is in milliseconds (sent as whole
 * seconds of `Max-Age`; 0 is sent, since it is how a cookie is expired),
 * `Path` defaults to `/`, and an invalid name, domain, path, sameSite or
 * expires throws a TypeError. Attributes come in a fixed order: Max-Age,
 * Expires, HttpOnly, Secure, SameSite, Domain, Path.
 *
 * `request` (and, on a serverless runtime, `response`) is what the cookie
 * answers: with no `secure` option the cookie is `Secure` when that request
 * arrived over TLS. Without them only an explicit `secure` counts.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: any = {},
  request?: unknown,
  response?: unknown
): string {
  assertCookieName(name);
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options === null) options = {};

  if (options.maxAge !== undefined && options.maxAge !== null) {
    const seconds = maxAgeSeconds(options.maxAge);
    if (seconds !== undefined) cookie += `; Max-Age=${seconds}`;
  }
  if (options.expires) cookie += `; Expires=${cookieExpires(options.expires)}`;
  if (options.httpOnly) cookie += '; HttpOnly';
  if (cookieIsSecure(name, options, request, response)) cookie += '; Secure';
  if (options.sameSite) cookie += `; SameSite=${cookieSameSite(options.sameSite)}`;
  if (options.domain) cookie += `; Domain=${cookieDomain(options.domain)}`;
  // Without a Path the browser scopes the cookie to the directory of the
  // current URL, and a clearCookie() from /auth/logout would miss a cookie
  // that was set at the site root.
  const path = options.path;
  cookie += path === undefined || path === null ? '; Path=/' : `; Path=${cookiePath(path)}`;

  return cookie;
}

/**
 * The options res.clearCookie(name, options) hands to res.cookie(): an
 * expiry in the past and `Max-Age=0`, with the attributes a browser matches a
 * cookie by (and the flags it was set with) taken from `options`.
 */
export function clearCookieOptions(options: any = {}): any {
  const clearOptions: any = { expires: new Date(0), maxAge: 0 };
  if (options === null) return clearOptions;
  if (options.path !== undefined) clearOptions.path = options.path;
  if (options.domain !== undefined) clearOptions.domain = options.domain;
  if (options.httpOnly !== undefined) clearOptions.httpOnly = options.httpOnly;
  if (options.secure !== undefined) clearOptions.secure = options.secure;
  if (options.sameSite !== undefined) clearOptions.sameSite = options.sameSite;
  return clearOptions;
}

/**
 * The error res.cookie(name, value, { signed: true }) throws when nothing can
 * sign the value: signing is done by the cookie middleware, which holds the
 * secret. Sending the value unsigned instead would hand the browser a cookie
 * the application believes is tamper-proof.
 */
export function unsignedCookieError(name: string): Error {
  return new Error(
    `res.cookie('${name}', ..., { signed: true }) cannot sign the cookie: no cookie signer is ` +
      `registered. Register middleware.cookie({ secret: '...' }) before setting signed cookies.`
  );
}

/**
 * Whether a proxy in front of the application says the request reached it
 * over https (`X-Forwarded-Proto: https`), as far as this server believes it:
 * what decides the `Secure` attribute of a cookie set behind a proxy.
 *
 * With `server.trustProxy` set, the servers honour that header only from a
 * trusted proxy and report the outcome on `req.secure`, so a request object
 * that says the connection is not secure overrules the header. Without the
 * setting `req.secure` follows the header and the answer is the header's.
 * Where the request has no `secure` at all, the header is read as it is.
 */
export function forwardedOverHttps(req: {
  headers: Record<string, unknown>;
  secure?: unknown;
}): boolean {
  if (req.headers['x-forwarded-proto'] !== 'https') return false;
  const secure = req.secure;
  return typeof secure === 'boolean' ? secure : true;
}
