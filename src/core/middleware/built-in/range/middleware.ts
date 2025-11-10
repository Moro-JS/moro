// HTTP Range Requests Middleware
import { Middleware } from '../../../../types/http.js';
import { RangeCore, RangeOptions } from './core.js';

/**
 * Create HTTP range requests middleware
 *
 * @example
 * ```typescript
 * import { range } from '@morojs/moro';
 *
 * app.use(range({
 *   acceptRanges: 'bytes',
 *   maxRanges: 1,
 * }));
 *
 * app.get('/video/:file', async (req, res) => {
 *   const filePath = `./videos/${req.params.file}`;
 *   await res.sendRange(filePath);
 * });
 * ```
 */
export function createRangeMiddleware(options: RangeOptions = {}): Middleware {
  const core = new RangeCore(options);

  return (req, res, next) => {
    core.addRangeMethod(req, res);
    next();
  };
}
