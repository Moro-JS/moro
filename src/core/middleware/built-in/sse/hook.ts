// SSE Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { SSECore, type SSEOptions } from './core.js';

const logger = createFrameworkLogger('SSEMiddleware');

/**
 * Server-Sent Events helpers for route handlers.
 *
 * Installed with `app.use(middleware.sse(options))`, it gives every response
 * `res.sse()`, which opens an event stream (status 200,
 * `Content-Type: text/event-stream`, the `retry` line and the `heartbeat`
 * timer when configured) and returns `{ sendEvent, sendComment, sendRetry,
 * close }`. `res.sendEvent()`, `res.sendComment()` and `res.sendRetry()` are
 * there too and open the stream on first use.
 *
 * Nothing opens on its own: a request is answered with a stream only when
 * its handler asks for one, after the route's own middleware and guards.
 *
 * @example
 * ```ts
 * app.use(middleware.sse({ heartbeat: 30000, retry: 3000 }));
 *
 * app.get('/events', (req, res) => {
 *   const stream = res.sse();
 *   const timer = setInterval(() => stream.sendEvent({ at: Date.now() }, 'tick'), 1000);
 *   req.on('close', () => clearInterval(timer));
 * });
 * ```
 */
export const sse = (options: SSEOptions = {}): MiddlewareInterface => ({
  name: 'sse',
  version: '1.0.0',
  metadata: {
    name: 'sse',
    version: '1.0.0',
    description: 'Server-Sent Events helpers with heartbeat and retry support',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing SSE middleware', 'Installation', { options: middlewareOptions });

    const config = { ...options, ...middlewareOptions };
    const sseCore = new SSECore(config);

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;
      if (!req || !res) return;
      sseCore.attach(req, res);
    });
  },
});
