// Cookie Core - Reusable cookie parsing and setting logic
import * as crypto from 'crypto';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { clearCookieOptions, serializeCookie } from '../../../http/utils/cookie-attributes.js';

// ===== Types =====

export interface CookieOptions {
  /**
   * Lifetime in milliseconds, as in Express. Sent as whole seconds of
   * `Max-Age`; `null` sends no `Max-Age`.
   */
  maxAge?: number | null;
  expires?: Date;
  httpOnly?: boolean;
  /**
   * Whether the cookie is `Secure`. Left out, it follows the connection: the
   * cookie is `Secure` when the request arrived over TLS (a TLS connection to
   * this server, or https as reported by a proxy named in `server.trustProxy`).
   */
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  domain?: string;
  path?: string;
  /**
   * Sign the value so tampering can be detected. Requires a `secret` on the
   * cookie middleware; signed cookies arrive on `req.signedCookies`, never on
   * `req.cookies`.
   */
  signed?: boolean;
}

/** Prefix marking a signed value, matching the cookie-parser convention. */
const SIGNED_PREFIX = 's:';

/**
 * One signing key, or several for rotation: values are signed with the first
 * and a value signed with any of them verifies. Entries that are not set
 * (`[process.env.SECRET, process.env.SECRET_PREVIOUS]` with the second one
 * absent) are skipped.
 */
export type CookieSecret = string | readonly (string | undefined | null)[];

/**
 * The usable keys of a `secret` option, in order: empty strings and
 * non-strings are dropped, so "no secret" is always an empty list.
 */
export function cookieSecrets(secret: CookieSecret | undefined | null): string[] {
  if (typeof secret === 'string') return secret ? [secret] : [];
  if (!Array.isArray(secret)) return [];
  return secret.filter((key): key is string => typeof key === 'string' && key !== '');
}

/** `s:<value>.<signature>` — HMAC-SHA256 of the value, base64url encoded. */
export function signCookieValue(value: string, secret: string): string {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64')
    .replace(/=+$/, '');
  return `${SIGNED_PREFIX}${value}.${signature}`;
}

/**
 * Verify a signed value, returning the payload or null when the value isn't
 * signed or the signature doesn't match. Comparison is constant-time. Given
 * several secrets, the value verifies when any one of them signed it.
 */
export function unsignCookieValue(signed: string, secret: CookieSecret): string | null {
  if (!signed.startsWith(SIGNED_PREFIX)) return null;

  const body = signed.slice(SIGNED_PREFIX.length);
  const separator = body.lastIndexOf('.');
  if (separator <= 0) return null;

  const value = body.slice(0, separator);
  const provided = Buffer.from(body.slice(separator + 1));

  if (typeof secret === 'string') {
    return signatureMatches(value, provided, secret) ? value : null;
  }
  for (let i = 0; i < secret.length; i++) {
    const key = secret[i];
    if (typeof key === 'string' && key !== '' && signatureMatches(value, provided, key)) {
      return value;
    }
  }
  return null;
}

function signatureMatches(value: string, provided: Buffer, secret: string): boolean {
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '')
  );
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/** Whether a raw cookie value carries the signed marker. */
export function isSignedCookieValue(value: string): boolean {
  return value.startsWith(SIGNED_PREFIX);
}

// ===== Core Logic =====

/**
 * Parse cookies from a Cookie header string
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  if (!cookieHeader) {
    return cookies;
  }

  // Avoid split/forEach, use single pass with indexOf
  let start = 0;
  const len = cookieHeader.length;

  for (let i = 0; i <= len; i++) {
    if (i === len || cookieHeader[i] === ';') {
      if (i > start) {
        const cookie = cookieHeader.substring(start, i).trim();
        const equalIndex = cookie.indexOf('=');
        if (equalIndex > 0) {
          const name = cookie.substring(0, equalIndex);
          const value = cookie.substring(equalIndex + 1);
          if (name && value) {
            try {
              cookies[name] = decodeURIComponent(value);
            } catch {
              cookies[name] = value;
            }
          }
        }
      }
      start = i + 1;
    }
  }

  return cookies;
}

/**
 * Visit every `name=value` pair of a Cookie header in order, repeated names
 * included. Accepts exactly the pairs parseCookies() does, decoded the same way.
 */
function eachCookie(cookieHeader: string, visit: (name: string, value: string) => void): void {
  let start = 0;
  const len = cookieHeader.length;

  for (let i = 0; i <= len; i++) {
    if (i === len || cookieHeader[i] === ';') {
      if (i > start) {
        const cookie = cookieHeader.substring(start, i).trim();
        const equalIndex = cookie.indexOf('=');
        if (equalIndex > 0) {
          const name = cookie.substring(0, equalIndex);
          const value = cookie.substring(equalIndex + 1);
          if (name && value) {
            let decoded = value;
            try {
              decoded = decodeURIComponent(value);
            } catch {
              // keep the raw value, as parseCookies() does
            }
            visit(name, decoded);
          }
        }
      }
      start = i + 1;
    }
  }
}

/**
 * Build a Set-Cookie header string from name, value, and options. `maxAge` is
 * in milliseconds (sent as whole seconds of `Max-Age`); an invalid name,
 * domain, path or sameSite throws a TypeError.
 *
 * `req` and `res` are the request the cookie answers and its response: with
 * no `secure` option the cookie is `Secure` when that request arrived over
 * TLS. Without them only an explicit `secure` counts.
 */
export function buildCookieString(
  name: string,
  value: string,
  options: CookieOptions = {},
  req?: unknown,
  res?: unknown
): string {
  return serializeCookie(name, value, options, req, res);
}

/**
 * CookieCore - Core cookie management logic
 * Used directly by the router for route-based cookie handling
 */
export class CookieCore {
  // Every key a signed cookie may verify against; the first one signs.
  private secrets: string[];
  private secret: string | undefined;

  /**
   * @param secret The signing key, or several for rotation: put the new key
   * first. Cookies are signed with the first key and a cookie signed with any
   * of them still verifies, so the old key can stay listed until the cookies
   * it signed have expired.
   */
  constructor(secret?: CookieSecret) {
    this.secrets = cookieSecrets(secret);
    this.secret = this.secrets[0];
  }

  /**
   * Parse cookies from request header
   */
  parseCookies(cookieHeader: string | undefined): Record<string, string> {
    return parseCookies(cookieHeader || '');
  }

  /**
   * Split parsed cookies into plain values and verified signed ones. A signed
   * cookie whose signature doesn't verify is dropped from both — a tampered
   * value must never look like a valid one.
   */
  splitSignedCookies(cookies: Record<string, string>): {
    cookies: Record<string, string>;
    signedCookies: Record<string, string>;
  } {
    if (!this.secret) return { cookies, signedCookies: {} };

    const plain: Record<string, string> = {};
    const signed: Record<string, string> = {};

    for (const name of Object.keys(cookies)) {
      const value = cookies[name] as string;
      if (!isSignedCookieValue(value)) {
        plain[name] = value;
        continue;
      }
      const verified = unsignCookieValue(value, this.secrets);
      if (verified !== null) signed[name] = verified;
    }

    return { cookies: plain, signedCookies: signed };
  }

  /**
   * Read a request's Cookie header into plain values and verified signed
   * ones. Signatures are checked per occurrence, before repeated names are
   * collapsed: a name that carries a verified signed value is a signed cookie
   * whatever else was sent under the same name, so a second cookie planted
   * with that name cannot hide it from `signedCookies` or stand in for it in
   * `cookies`. Names without a verified value resolve as before - the last
   * occurrence decides, and a signed value that fails verification is dropped.
   * @internal
   */
  readCookies(cookieHeader: string | undefined): {
    cookies: Record<string, string>;
    signedCookies: Record<string, string>;
  } {
    // One key is the common case: verify against the string, not a list
    const secret: CookieSecret | undefined = this.secrets.length > 1 ? this.secrets : this.secret;
    if (!secret || !cookieHeader) {
      return { cookies: parseCookies(cookieHeader || ''), signedCookies: {} };
    }

    const plain: Record<string, string> = {};
    const signed: Record<string, string> = {};

    eachCookie(cookieHeader, (name, value) => {
      if (!isSignedCookieValue(value)) {
        plain[name] = value;
        return;
      }
      const verified = unsignCookieValue(value, secret);
      if (verified !== null) {
        signed[name] = verified;
      } else if (plain[name] !== undefined) {
        delete plain[name];
      }
    });

    for (const name of Object.keys(signed)) {
      if (plain[name] !== undefined) delete plain[name];
    }

    return { cookies: plain, signedCookies: signed };
  }

  /**
   * Set a cookie on the response
   */
  setCookie(
    res: HttpResponse,
    name: string,
    value: string,
    options: CookieOptions = {},
    req?: HttpRequest
  ): void {
    let outgoing = value;
    if (options.signed) {
      if (!this.secret) {
        throw new Error(
          `Cookie '${name}' was set with signed: true but no secret is configured. ` +
            `Pass one to the middleware: middleware.cookie({ secret: '...' }).`
        );
      }
      outgoing = signCookieValue(value, this.secret);
    }

    const cookieString = buildCookieString(name, outgoing, options, req, res);

    const existingCookies = res.getHeader('Set-Cookie') || [];
    // Avoid spread operator - direct array manipulation
    const cookies = Array.isArray(existingCookies) ? existingCookies : [existingCookies as string];
    cookies.push(cookieString);
    res.setHeader('Set-Cookie', cookies);
  }

  /**
   * Clear a cookie by setting its expiration to the past
   */
  clearCookie(
    res: HttpResponse,
    name: string,
    options: CookieOptions = {},
    req?: HttpRequest
  ): void {
    const clearOptions: CookieOptions = clearCookieOptions(options);
    this.setCookie(res, name, '', clearOptions, req);
  }
}
