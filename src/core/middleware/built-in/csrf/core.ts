// CSRF Core - Reusable CSRF protection logic
import crypto from 'crypto';
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { applyGlobalHelmet } from '../helmet/core.js';
import { applyGlobalCORS } from '../cors/core.js';
import { arrivedOverTls, forwardedOverHttps } from '../../../http/utils/cookie-attributes.js';

const logger = createFrameworkLogger('CSRFCore');

// ===== Types =====

export interface CSRFOptions {
  /**
   * Signs every token, so only a token this application issued verifies. Set
   * it (from the environment): without one a random secret is generated at
   * start-up and tokens do not survive a restart or work across instances.
   */
  secret?: string;
  tokenLength?: number;
  cookieName?: string;
  headerName?: string;
  ignoreMethods?: string[];
  sameSite?: boolean;
  /**
   * Also read the token from the `_csrf` query parameter. Off by default: a
   * token in a URL ends up in logs, browser history and Referer headers.
   */
  allowQueryToken?: boolean;
  /**
   * Accept the unsigned tokens earlier versions issued (a bare hex string in
   * both the cookie and the request), with one warning per process. Default
   * true for this release so that pages open during an upgrade keep working;
   * set false to refuse them now.
   */
  legacyTokens?: boolean;
  /**
   * When the request has a session (`req.session`, from the session
   * middleware registered before this one), tie each token to it: a token
   * issued in one session does not verify in another. Default true.
   */
  bindToSession?: boolean;
  /** The session field the per-session value is kept in. Default 'csrfSecret'. */
  sessionKey?: string;
}

const CSRF_REJECTION_CODE = 'CSRF_TOKEN_MISMATCH';
const HEX_TOKEN = /^[0-9a-f]+$/;
const DEFAULT_SESSION_KEY = 'csrfSecret';

/** Request field: the session the check saw (an object), or null when it saw none. */
const SESSION_AT_CHECK = '_csrfSession';

let legacyTokenWarned = false;
let lateSessionWarned = false;

/**
 * Validate the request's token and answer 403 when it does not verify.
 * Returns true when the request may continue. Shared by the hook and the
 * middleware; a rejection is an expected outcome, so it is answered here
 * instead of being thrown at the server's error boundary (which would report
 * it as a 500).
 */
export async function passesCSRFCheck(
  core: CSRFCore,
  req: HttpRequest,
  res: HttpResponse,
  // true when called from the hook, which answers ahead of function
  // middleware (and possibly ahead of the CORS hook): the 403 then carries
  // the application's helmet and CORS headers
  aheadOfMiddleware = false
): Promise<boolean> {
  try {
    core.noteSession(req);
    await core.validateToken(req);
    return true;
  } catch (error) {
    if ((error as any)?.code !== CSRF_REJECTION_CODE) throw error;
    if (!res.headersSent) {
      if (aheadOfMiddleware) {
        applyGlobalHelmet(req, res);
        await applyGlobalCORS(req, res);
      }
      res.status(403).json({
        success: false,
        error: 'Invalid CSRF token',
        code: CSRF_REJECTION_CODE,
      });
    }
    return false;
  }
}

// ===== Core Logic =====

/**
 * CSRFCore - Core CSRF protection logic
 * Used directly by the router for route-based CSRF protection
 * Can be instantiated for use in middleware or hooks
 */
export class CSRFCore {
  private secret: string;
  private tokenLength: number;
  private cookieName: string;
  private headerName: string;
  private ignoreMethods: string[];
  private sameSite: boolean;
  private allowQueryToken: boolean;
  private legacyTokens: boolean;
  private bindToSession: boolean;
  private sessionKey: string;

  constructor(options: CSRFOptions = {}) {
    this.secret =
      options.secret ||
      (() => {
        const generated = crypto.randomBytes(32).toString('hex');
        logger.warn(
          '[MoroJS Security] No secret configured for CSRF. A random secret was generated — CSRF tokens will NOT survive restarts. Set an explicit secret for production use.',
          'CSRFCore'
        );
        return generated;
      })();
    this.tokenLength = options.tokenLength || 32;
    this.cookieName = options.cookieName || '_csrf';
    // Request header names arrive lower-cased, whatever case was configured
    this.headerName = (options.headerName || 'x-csrf-token').toLowerCase();
    this.ignoreMethods = options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS'];
    this.sameSite = options.sameSite !== false;
    this.allowQueryToken = options.allowQueryToken === true;
    this.legacyTokens = options.legacyTokens !== false;
    this.bindToSession = options.bindToSession !== false;
    this.sessionKey = options.sessionKey || DEFAULT_SESSION_KEY;
  }

  /**
   * A new token: `<random hex>.<signature>`, the signature being an
   * HMAC-SHA256 of the random part under the configured secret - and of
   * `sessionValue` too when one is given, which ties the token to the session
   * that holds that value.
   */
  generateToken(sessionValue?: string): string {
    const random = crypto.randomBytes(this.tokenLength).toString('hex');
    return `${random}.${this.sign(random, sessionValue)}`;
  }

  private sign(random: string, sessionValue: string | undefined): string {
    // The two forms are signed over different text, so a token issued without
    // a session never verifies as one issued for a session, or the reverse.
    const message = sessionValue === undefined ? `u.${random}` : `s.${random}.${sessionValue}`;
    return crypto.createHmac('sha256', this.secret).update(message).digest('base64url');
  }

  /** Whether `token` was issued here, for this session value when one is given. */
  private isSignedToken(token: unknown, sessionValue: string | undefined): token is string {
    if (typeof token !== 'string') return false;
    const separator = token.indexOf('.');
    if (separator !== this.tokenLength * 2) return false;
    const random = token.slice(0, separator);
    if (!HEX_TOKEN.test(random)) return false;
    const provided = Buffer.from(token.slice(separator + 1));
    const expected = Buffer.from(this.sign(random, sessionValue));
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  /** A token in the unsigned form earlier versions issued: bare hex of the configured length. */
  private isLegacyToken(value: unknown): value is string {
    return (
      typeof value === 'string' && value.length === this.tokenLength * 2 && HEX_TOKEN.test(value)
    );
  }

  /**
   * Record whether the request has a session at the point the token is
   * checked. Tokens are issued against that same answer, so a session
   * middleware registered after this one (whose session is not there yet when
   * the check runs) cannot make every issued token fail its own check.
   */
  noteSession(req: HttpRequest): void {
    (req as any)[SESSION_AT_CHECK] = this.sessionOf(req) ?? null;
  }

  private sessionOf(req: HttpRequest): Record<string, any> | undefined {
    if (!this.bindToSession) return undefined;
    const session = (req as any).session;
    return session !== null && typeof session === 'object' ? session : undefined;
  }

  /** The session tokens of this request are tied to, if any. */
  private boundSession(req: HttpRequest): Record<string, any> | undefined {
    const noted = (req as any)[SESSION_AT_CHECK];
    if (noted === undefined) return this.sessionOf(req);
    if (noted === null) {
      if (!lateSessionWarned && this.sessionOf(req) !== undefined) {
        lateSessionWarned = true;
        logger.warn(
          'CSRF tokens are not tied to the session: the session middleware is registered after ' +
            'the CSRF middleware. Register session() first.',
          'CSRFCore'
        );
      }
      return undefined;
    }
    return noted;
  }

  /** The per-session value tokens are signed with, when the session has one. */
  private sessionValue(session: Record<string, any>): string | undefined {
    const value = session[this.sessionKey];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  verifyToken(token: string, sessionToken: string): boolean {
    if (!token || !sessionToken || token.length !== sessionToken.length) {
      return false;
    }
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken));
    } catch {
      return false;
    }
  }

  /**
   * The request's token: the one its cookie already carries, else the one
   * issued earlier in this request, else a new one (set as the cookie). Every
   * call within a request, and every request that sends the cookie back, gets
   * the same value, so a token read for one form stays valid when another is
   * rendered.
   *
   * With a session, the token is signed over a random value kept in the
   * session (created, and the session saved, the first time a token is
   * issued in it), so it verifies in that session only. A session that is
   * regenerated or destroyed - at login and logout - starts without that
   * value: ask for a new token afterwards.
   */
  async attachToken(req: HttpRequest, res: HttpResponse): Promise<string> {
    let token = (req as any)._csrfToken;

    if (!token) {
      const session = this.boundSession(req);
      let sessionValue = session ? this.sessionValue(session) : undefined;

      // Reuse the cookie's token only when it is one issued here (for this
      // session, when there is one); anything else - an unsigned token from an
      // earlier version included - is replaced rather than handed to the page.
      const existing = this.cookieToken(req);
      if ((!session || sessionValue !== undefined) && this.isSignedToken(existing, sessionValue)) {
        (req as any)._csrfToken = existing;
        return existing;
      }

      let created = false;
      if (session && sessionValue === undefined) {
        sessionValue = crypto.randomBytes(16).toString('hex');
        session[this.sessionKey] = sessionValue;
        created = true;
      }

      token = this.generateToken(sessionValue);
      (req as any)._csrfToken = token;

      // Set token in cookie
      res.cookie(this.cookieName, token, {
        httpOnly: true,
        secure: forwardedOverHttps(req) || arrivedOverTls(req, res),
        ...(this.sameSite ? { sameSite: 'strict' as const } : {}),
      });

      // The token is only good once the session holds the value it was signed
      // with: store it before the token is handed out, not after the response.
      if (created && session && typeof session.save === 'function') {
        await session.save();
      }
    }

    return token;
  }

  /**
   * The token cookie as the request carries it. A cookie middleware that
   * signs every cookie delivers it, verified, on `req.signedCookies`.
   */
  private cookieToken(req: HttpRequest): string | undefined {
    return (
      req.cookies?.[this.cookieName] ??
      (req as { signedCookies?: Record<string, string> }).signedCookies?.[this.cookieName]
    );
  }

  async validateToken(req: HttpRequest): Promise<void> {
    // Skip verification for safe methods
    const method = req.method || 'GET';
    if (this.ignoreMethods.includes(method)) {
      return;
    }

    // Get token from header or body (and the query string only when enabled)
    const token =
      req.headers[this.headerName] ||
      ((req as any).body && (req as any).body._csrf) ||
      (this.allowQueryToken && (req as any).query && (req as any).query._csrf);

    // Get session token from cookie
    const sessionToken = this.cookieToken(req);

    // 1. The request must repeat the cookie's token
    if (!this.verifyToken(token as string, sessionToken || '')) {
      throw this.rejection();
    }

    // 2. ... and that token must be one issued here. A value merely written
    // into both places (by anything able to set a cookie for the site) is
    // not: it carries no signature under the secret.
    if (this.isLegacyToken(sessionToken)) {
      if (!this.legacyTokens) throw this.rejection();
      if (!legacyTokenWarned) {
        legacyTokenWarned = true;
        logger.warn(
          '[MoroJS Security] Accepted an unsigned CSRF token of the format earlier versions issued. ' +
            'Tokens are now signed; unsigned ones are accepted for this release only ' +
            '(csrf({ legacyTokens: false }) refuses them now).',
          'CSRFCore'
        );
      }
      return;
    }

    // 3. With a session, it must also be the token of this session
    const session = this.boundSession(req);
    let sessionValue: string | undefined;
    if (session) {
      sessionValue = this.sessionValue(session);
      if (sessionValue === undefined) throw this.rejection();
    }
    if (!this.isSignedToken(sessionToken, sessionValue)) {
      throw this.rejection();
    }
  }

  private rejection(): Error {
    const error = new Error('Invalid CSRF token');
    (error as any).status = 403;
    (error as any).code = CSRF_REJECTION_CODE;
    return error;
  }

  getCookieName(): string {
    return this.cookieName;
  }
}
