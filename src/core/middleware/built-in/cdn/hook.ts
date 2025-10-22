// CDN Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CDNCore } from './core.js';
import { CDNOptions } from '../../../../types/cdn.js';

const logger = createFrameworkLogger('CDNMiddleware');

/**
 * CDN hook for global usage
 * Registers with the hooks system for application-wide CDN support
 *
 * @example
 * ```ts
 * import { cdn } from '@/middleware/built-in/cdn';
 *
 * app.use(cdn({
 *   adapter: 'cloudflare',
 *   adapterOptions: {
 *     zoneId: 'your-zone-id',
 *     apiToken: 'your-api-token'
 *   },
 *   autoInvalidate: true,
 *   invalidationPatterns: ['/api/.*']
 * }));
 * ```
 */
export const cdn = (options: CDNOptions = {}): MiddlewareInterface => ({
  name: 'cdn',
  version: '1.0.0',
  metadata: {
    name: 'cdn',
    version: '1.0.0',
    description: 'Built-in CDN middleware with pluggable provider adapters',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing CDN middleware', 'Installation');

    const config = { ...options, ...middlewareOptions };
    const cdnCore = new CDNCore(config);

    if (!cdnCore.hasAdapter()) {
      logger.warn('No CDN adapter configured, CDN features will be disabled', 'Installation');
      return;
    }

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Set CDN headers on all responses
      cdnCore.setHeaders(res);

      // Add CDN methods to response
      res.purgeCDN = async (urls?: string[]) => {
        const urlsToPurge = urls || [req.path];
        await cdnCore.purge(urlsToPurge);
      };

      res.prefetchCDN = async (urls: string[]) => {
        await cdnCore.prefetch(urls);
      };

      res.getCDNStats = async () => {
        return await cdnCore.getStats();
      };
    });

    // Auto-invalidation on certain patterns
    if (config.autoInvalidate && config.invalidationPatterns) {
      hooks.after('response', async (context: HookContext) => {
        const req = context.request as any;
        await cdnCore.autoInvalidate(req.path);
      });
    }

    logger.info('CDN middleware installed', 'Installation', {
      adapter: typeof config.adapter === 'string' ? config.adapter : 'custom',
      autoInvalidate: !!config.autoInvalidate,
    });
  },
});
