// Session Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { SessionCore, type SessionOptions } from './core.js';

const logger = createFrameworkLogger('SessionMiddleware');

/**
 * Create session middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const sessionMw = createSessionMiddleware({
 *   store: 'redis',
 *   name: 'my-session',
 *   cookie: { maxAge: 3600000 }
 * });
 *
 * app.use(sessionMw);
 * ```
 */
export function createSessionMiddleware(options: SessionOptions = {}): StandardMiddleware {
  const sessionCore = new SessionCore(options);
  const cookieName = options.name || 'connect.sid';

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    try {
      // Get session ID from cookie
      const sessionId = req.cookies?.[cookieName];

      // Attach session to request
      (req as any).session = await sessionCore.attachSession(req, res, sessionId);

      // Execute next middleware
      await next();

      // Save session after response
      await sessionCore.saveSession((req as any).session);
    } catch (error) {
      logger.error('Session middleware error', 'SessionError', { error });
      throw error;
    }
  };
}
