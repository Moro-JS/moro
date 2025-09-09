// CSRF Protection Middleware
import { MiddlewareInterface, HookContext } from '../../../types/hooks';
import { createFrameworkLogger } from '../../logger';

const logger = createFrameworkLogger('CSRFMiddleware');

export const csrf = (
  options: {
    secret?: string;
    tokenLength?: number;
    cookieName?: string;
    headerName?: string;
    ignoreMethods?: string[];
    sameSite?: boolean;
  } = {}
): MiddlewareInterface => ({
  name: 'csrf',
  version: '1.0.0',
  metadata: {
    name: 'csrf',
    version: '1.0.0',
    description: 'CSRF protection middleware with token generation and validation',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing CSRF middleware', 'Installation');

    const secret = options.secret || 'moro-csrf-secret';
    const tokenLength = options.tokenLength || 32;
    const cookieName = options.cookieName || '_csrf';
    const headerName = options.headerName || 'x-csrf-token';
    const ignoreMethods = options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS'];

    const generateToken = () => {
      const crypto = require('crypto');
      return crypto.randomBytes(tokenLength).toString('hex');
    };

    const verifyToken = (token: string, sessionToken: string) => {
      return token && sessionToken && token === sessionToken;
    };

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Add CSRF token generation method
      req.csrfToken = () => {
        if (!req._csrfToken) {
          req._csrfToken = generateToken();
          // Set token in cookie
          res.cookie(cookieName, req._csrfToken, {
            httpOnly: true,
            sameSite: options.sameSite !== false ? 'strict' : undefined,
            secure: req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted,
          });
        }
        return req._csrfToken;
      };

      // Skip verification for safe methods
      if (ignoreMethods.includes(req.method!)) {
        return;
      }

      // Get token from header or body
      const token =
        req.headers[headerName] || (req.body && req.body._csrf) || (req.query && req.query._csrf);

      // Get session token from cookie
      const sessionToken = req.cookies?.[cookieName];

      if (!verifyToken(token as string, sessionToken || '')) {
        const error = new Error('Invalid CSRF token');
        (error as any).status = 403;
        (error as any).code = 'CSRF_TOKEN_MISMATCH';
        throw error;
      }
    });
  },
});
