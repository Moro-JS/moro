// CDN Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { CDNCore } from './core.js';
import { CDNOptions } from '../../../../types/cdn.js';

/**
 * Create CDN middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const cdnMw = createCDNMiddleware({
 *   adapter: 'cloudflare',
 *   adapterOptions: {
 *     zoneId: 'your-zone-id',
 *     apiToken: 'your-api-token'
 *   },
 *   autoInvalidate: true,
 *   invalidationPatterns: ['/api/.*']
 * });
 *
 * app.use(cdnMw);
 * ```
 */
export function createCDNMiddleware(options: CDNOptions = {}): StandardMiddleware {
  const cdnCore = new CDNCore(options);

  if (!cdnCore.hasAdapter()) {
    // Return no-op middleware if no adapter configured
    return async (_req: HttpRequest, _res: HttpResponse, next: () => Promise<void>) => {
      await next();
    };
  }

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    const reqAny = req as any;
    const resAny = res as any;

    // Set CDN headers
    cdnCore.setHeaders(res);

    // Add CDN methods to response
    resAny.purgeCDN = async (urls?: string[]) => {
      const urlsToPurge = urls || [reqAny.path || reqAny.url];
      await cdnCore.purge(urlsToPurge);
    };

    resAny.prefetchCDN = async (urls: string[]) => {
      await cdnCore.prefetch(urls);
    };

    resAny.getCDNStats = async () => {
      return await cdnCore.getStats();
    };

    await next();

    // Auto-invalidate after response if configured
    if (options.autoInvalidate) {
      const path = reqAny.path || reqAny.url;
      await cdnCore.autoInvalidate(path);
    }
  };
}
