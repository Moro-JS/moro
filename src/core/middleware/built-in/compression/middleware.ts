// Compression Middleware
import { Middleware } from '../../../../types/http.js';
import { CompressionCore, CompressionOptions } from './core.js';

/**
 * Create compression middleware
 *
 * @example
 * ```typescript
 * import { compression } from '@morojs/moro';
 *
 * app.use(compression({
 *   threshold: 1024, // Only compress responses > 1KB
 *   level: 6, // Compression level (0-9)
 *   filter: (req, res) => {
 *     // Don't compress images
 *     return !req.path.match(/\.(jpg|jpeg|png|gif)$/);
 *   },
 * }));
 * ```
 */
export function createCompressionMiddleware(options: CompressionOptions = {}): Middleware {
  const core = new CompressionCore(options);

  return (req, res, next) => {
    if (core.shouldCompress(req, res)) {
      core.wrapResponse(req, res);
    }
    next();
  };
}
