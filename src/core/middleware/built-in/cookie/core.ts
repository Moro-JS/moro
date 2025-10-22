// Cookie Core - Reusable cookie parsing and setting logic
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

  cookieHeader.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) {
      cookies[name] = decodeURIComponent(value);
    }
  });

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
  constructor() {}

  /**
   * Parse cookies from request header
   */
  parseCookies(cookieHeader: string | undefined): Record<string, string> {
    return parseCookies(cookieHeader || '');
  }

  /**
   * Set a cookie on the response
   */
  setCookie(res: HttpResponse, name: string, value: string, options: CookieOptions = {}): void {
    const cookieString = buildCookieString(name, value, options);

    const existingCookies = res.getHeader('Set-Cookie') || [];
    const cookies = Array.isArray(existingCookies)
      ? [...existingCookies]
      : [existingCookies as string];
    cookies.push(cookieString);
    res.setHeader('Set-Cookie', cookies);
  }

  /**
   * Clear a cookie by setting its expiration to the past
   */
  clearCookie(res: HttpResponse, name: string, options: CookieOptions = {}): void {
    const clearOptions: CookieOptions = {
      ...options,
      expires: new Date(0),
      maxAge: 0,
    };
    this.setCookie(res, name, '', clearOptions);
  }
}
