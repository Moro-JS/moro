// CSRF Core - Reusable CSRF protection logic
import crypto from 'crypto';
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('CSRFCore');

// ===== Types =====

export interface CSRFOptions {
  secret?: string;
  tokenLength?: number;
  cookieName?: string;
  headerName?: string;
  ignoreMethods?: string[];
  sameSite?: boolean;
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
    this.headerName = options.headerName || 'x-csrf-token';
    this.ignoreMethods = options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS'];
    this.sameSite = options.sameSite !== false;
  }

  generateToken(): string {
    return crypto.randomBytes(this.tokenLength).toString('hex');
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

  async attachToken(req: HttpRequest, res: HttpResponse): Promise<string> {
    let token = (req as any)._csrfToken;

    if (!token) {
      token = this.generateToken();
      (req as any)._csrfToken = token;

      // Set token in cookie
      res.cookie(this.cookieName, token, {
        httpOnly: true,
        sameSite: this.sameSite ? 'strict' : undefined,
        secure: req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted,
      });
    }

    return token;
  }

  async validateToken(req: HttpRequest): Promise<void> {
    // Skip verification for safe methods
    const method = req.method || 'GET';
    if (this.ignoreMethods.includes(method)) {
      return;
    }

    // Get token from header or body
    const token =
      req.headers[this.headerName] ||
      ((req as any).body && (req as any).body._csrf) ||
      ((req as any).query && (req as any).query._csrf);

    // Get session token from cookie
    const sessionToken = req.cookies?.[this.cookieName];

    if (!this.verifyToken(token as string, sessionToken || '')) {
      const error = new Error('Invalid CSRF token');
      (error as any).status = 403;
      (error as any).code = 'CSRF_TOKEN_MISMATCH';
      throw error;
    }
  }

  getCookieName(): string {
    return this.cookieName;
  }
}
