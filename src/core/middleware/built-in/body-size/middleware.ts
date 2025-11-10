// Body Size Limit Middleware
import { Middleware } from '../../../../types/http.js';
import { BodySizeCore, BodySizeOptions } from './core.js';

/**
 * Create body size limit middleware
 *
 * @example
 * ```typescript
 * import { bodySize } from '@morojs/moro';
 *
 * app.use(bodySize({ limit: '10mb' }));
 * app.use(bodySize({ limit: 1024 * 1024 * 5 })); // 5MB
 * ```
 */
export function createBodySizeMiddleware(options: BodySizeOptions = {}): Middleware {
  const core = new BodySizeCore(options);

  return (req, res, next) => {
    if (!core.checkBodySize(req, res)) {
      return; // Request rejected
    }
    next();
  };
}
