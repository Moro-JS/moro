// Session Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { SessionCore, type SessionOptions } from './core.js';

const logger = createFrameworkLogger('SessionMiddleware');

/**
 * Session hook for global usage
 * Registers with the hooks system for application-wide session management
 *
 * @example
 * ```ts
 * import { session } from '@/middleware/built-in/session';
 *
 * app.use(session({
 *   store: 'redis',
 *   cookie: { maxAge: 86400000 }
 * }));
 * ```
 */
export const session = (options: SessionOptions = {}): MiddlewareInterface => ({
  name: 'session',
  version: '1.0.0',
  metadata: {
    name: 'session',
    version: '1.0.0',
    description: 'Session management middleware with multiple store adapters',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing session middleware', 'Installation');

    // Merge options
    const config: SessionOptions = {
      ...options,
      ...middlewareOptions,
    };

    const sessionCore = new SessionCore(config);
    const cookieName = config.name || 'connect.sid';

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Get session ID from cookie
      const sessionId = req.cookies?.[cookieName];

      // Attach session to request
      req.session = await sessionCore.attachSession(req, res, sessionId);
    });

    hooks.after('response', async (context: HookContext) => {
      const req = context.request as any;

      if (req.session) {
        await sessionCore.saveSession(req.session);
      }
    });

    logger.info(`Session middleware installed with ${config.store} store`, 'Installation');
  },
});
