// Static File Serving Middleware
import { Middleware } from '../../../../types/http.js';
import { StaticCore, StaticOptions } from './core.js';

/**
 * Create static file serving middleware
 *
 * @example
 * ```typescript
 * import { staticFiles } from '@morojs/moro';
 *
 * app.use(staticFiles({
 *   root: './public',
 *   maxAge: 3600, // 1 hour cache
 *   index: ['index.html'],
 *   etag: true,
 * }));
 *
 * // Mounted under a URL prefix — ./public/app.css is served as /cdn/app.css.
 * // Note the prefix goes in the options, not as app.use('/cdn', ...), which
 * // only mounts createRouter() instances.
 * app.use(staticFiles({ root: './public', prefix: '/cdn' }));
 * ```
 */
export function createStaticMiddleware(options: StaticOptions): Middleware {
  const core = new StaticCore(options);

  return async (req, res, next) => {
    const handled = await core.handleRequest(req, res);
    if (!handled) {
      next();
    }
  };
}
