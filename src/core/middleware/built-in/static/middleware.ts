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
