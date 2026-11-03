// Compression Middleware
import { Middleware } from '../../../../types/http.js';
import { CompressionCore, CompressionOptions } from './core.js';
import {
  resolveCompressionSettings,
  type CompressionSettings,
} from '../../../http/utils/compression.js';

/**
 * Create compression middleware
 *
 * On a server whose buffered responses compress themselves (the native
 * engine) the middleware hands its settings to the response and steps aside:
 * one property write per request, and json/send keep their shapes. A
 * `filter` is consulted per response, so it keeps the wrapping path; so does
 * every other server.
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
  const native: CompressionSettings | undefined = options.filter
    ? undefined
    : resolveCompressionSettings({
        compression: {
          enabled: true,
          ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
          ...(options.level !== undefined ? { level: options.level } : {}),
          ...(options.encodings !== undefined ? { encodings: options.encodings } : {}),
          ...(options.maxInlineBytes !== undefined
            ? { maxInlineBytes: options.maxInlineBytes }
            : {}),
          ...(options.gzip !== undefined ? { gzip: options.gzip } : {}),
          ...(options.brotli !== undefined ? { brotli: options.brotli } : {}),
          ...(options.reuseEncoders !== undefined ? { reuseEncoders: options.reuseEncoders } : {}),
        },
      });

  return (req, res, next) => {
    const useCompression = (res as any)._useCompression;
    if (native !== undefined && typeof useCompression === 'function') {
      useCompression.call(res, native);
    } else if (core.shouldCompress(req, res)) {
      core.wrapResponse(req, res);
    }
    next();
  };
}
