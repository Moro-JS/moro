// Cookie Core - Reusable cookie parsing and setting logic
import * as crypto from 'crypto';
import { HttpResponse } from '../../../../types/http.js';

// ===== Types =====

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
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
 * signed or the signature doesn't match. Comparison is constant-time.
 */
export function unsignCookieValue(signed: string, secret: string): string | null {
  if (!signed.startsWith(SIGNED_PREFIX)) return null;

  const body = signed.slice(SIGNED_PREFIX.length);
  const separator = body.lastIndexOf('.');
  if (separator <= 0) return null;

  const value = body.slice(0, separator);
  const provided = Buffer.from(body.slice(separator + 1));
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '')
  );

  if (provided.length !== expected.length) return null;
  return crypto.timingSafeEqual(provided, expected) ? value : null;
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
 * Build a Set-Cookie header string from name, value, and options
 */
export function buildCookieString(
  name: string,
  value: string,
  options: CookieOptions = {}
): string {
  const cookieValue = encodeURIComponent(value);
  let cookieString = `${name}=${cookieValue}`;

  if (options.maxAge !== undefined) {
    cookieString += `; Max-Age=${options.maxAge}`;
  }

  if (options.expires) {
    cookieString += `; Expires=${options.expires.toUTCString()}`;
  }

  if (options.httpOnly) {
    cookieString += '; HttpOnly';
  }

  if (options.secure) {
    cookieString += '; Secure';
  }

  if (options.sameSite) {
    cookieString += `; SameSite=${options.sameSite}`;
  }

  if (options.domain) {
    cookieString += `; Domain=${options.domain}`;
  }

  if (options.path) {
    cookieString += `; Path=${options.path}`;
  }

  return cookieString;
}

/**
 * CookieCore - Core cookie management logic
 * Used directly by the router for route-based cookie handling
 */
export class CookieCore {
  private secret: string | undefined;

  constructor(secret?: string) {
    this.secret = secret;
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
      const verified = unsignCookieValue(value, this.secret);
      if (verified !== null) signed[name] = verified;
    }

    return { cookies: plain, signedCookies: signed };
  }

  /**
   * Set a cookie on the response
   */
  setCookie(res: HttpResponse, name: string, value: string, options: CookieOptions = {}): void {
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

    const cookieString = buildCookieString(name, outgoing, options);

    const existingCookies = res.getHeader('Set-Cookie') || [];
    // Avoid spread operator - direct array manipulation
    const cookies = Array.isArray(existingCookies) ? existingCookies : [existingCookies as string];
    cookies.push(cookieString);
    res.setHeader('Set-Cookie', cookies);
  }

  /**
   * Clear a cookie by setting its expiration to the past
   */
  clearCookie(res: HttpResponse, name: string, options: CookieOptions = {}): void {
    // Avoid spread operator - manually set properties
    const clearOptions: CookieOptions = {
      expires: new Date(0),
      maxAge: 0,
    };
    // Copy other options manually
    if (options.path !== undefined) clearOptions.path = options.path;
    if (options.domain !== undefined) clearOptions.domain = options.domain;
    if (options.httpOnly !== undefined) clearOptions.httpOnly = options.httpOnly;
    if (options.secure !== undefined) clearOptions.secure = options.secure;
    if (options.sameSite !== undefined) clearOptions.sameSite = options.sameSite;
    this.setCookie(res, name, '', clearOptions);
  }
}
