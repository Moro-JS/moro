// HTTP Range Requests Middleware
import { Middleware } from '../../../../types/http.js';
import { RangeCore, RangeOptions } from './core.js';

/**
 * Create HTTP range requests middleware
 *
 * Adds `res.sendRange(filePath)`, which sends a file and answers `Range`
 * requests with `206 Partial Content` (suffix ranges, clamping and `If-Range`
 * per RFC 9110), an unsatisfiable range with `416`, and a missing file with
 * `404`. A request for more than `maxRanges` ranges gets the whole file.
 *
 * Without `root`, `sendRange` serves whatever path it is given - and route
 * params arrive percent-decoded (`..%2F` is `../` by the time the handler
 * runs). Set `root`, here or per call (`res.sendRange(file, { root })`), and
 * the path is resolved against that directory: `../`, an absolute path or a
 * symlink that leads outside it gets a 404.
 *
 * The response carries the file's own `Content-Type` (unless the handler set
 * one) and `X-Content-Type-Options: nosniff`. A hidden path (a segment that
 * starts with a dot, `.well-known` aside) gets a 404 unless `dotfiles` says
 * otherwise: `'ignore'` (default), `'deny'` (403) or `'allow'`.
 *
 * @example
 * ```typescript
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.range({
 *   acceptRanges: 'bytes',
 *   maxRanges: 1,
 *   root: './videos',
 * }));
 *
 * app.get('/videos/:id', async (req, res) => {
 *   await res.sendRange(`${req.params.id}.mp4`);
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
