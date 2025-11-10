// HTTP/2 Server Push Middleware
import { Middleware } from '../../../../types/http.js';
import { Http2PushCore, Http2PushOptions } from './core.js';

/**
 * Create HTTP/2 Server Push middleware
 *
 * @example
 * ```typescript
 * import { http2 } from '@morojs/moro';
 *
 * app.use(http2.push({
 *   autoDetect: true,
 *   resources: [
 *     { path: '/styles/main.css', as: 'style', type: 'text/css', priority: 200 },
 *     { path: '/scripts/app.js', as: 'script', type: 'application/javascript', priority: 150 },
 *   ],
 *   condition: (req) => req.path === '/' || req.path.endsWith('.html'),
 * }));
 * ```
 */
export function createHttp2PushMiddleware(options: Http2PushOptions = {}): Middleware {
  const core = new Http2PushCore(options);

  return (req, res, next) => {
    // Add push capability to response
    core.addPushCapability(req, res);

    // Setup auto-detection if enabled
    core.setupAutoDetect(req, res);

    // Push configured resources
    core.pushConfiguredResources(req, res);

    next();
  };
}
