// Built-in CDN Middleware
import { MiddlewareInterface, HookContext } from '../../../types/hooks.js';
import { CDNAdapter, CDNOptions } from '../../../types/cdn.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { createCDNAdapter } from './adapters/cdn/index.js';

const logger = createFrameworkLogger('CDNMiddleware');

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

    // Initialize CDN adapter
    let cdnAdapter: CDNAdapter | null = null;

    if (options.adapter && typeof options.adapter === 'object' && 'purge' in options.adapter) {
      cdnAdapter = options.adapter as CDNAdapter;
    } else if (typeof options.adapter === 'string') {
      cdnAdapter = createCDNAdapter(options.adapter, options.adapterOptions);
    }

    if (!cdnAdapter) {
      logger.warn('No CDN adapter configured, CDN features will be disabled', 'Installation');
      return;
    }

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Set CDN headers on all responses
      if (cdnAdapter) {
        cdnAdapter.setHeaders(res);
      }

      // Add CDN methods to response
      res.purgeCDN = async (urls?: string[]) => {
        if (!cdnAdapter) {
          logger.warn('CDN purge requested but no adapter configured', 'CDNPurge');
          return;
        }

        try {
          const urlsToPurge = urls || [req.path];
          await cdnAdapter.purge(urlsToPurge);
          logger.info(`CDN cache purged: ${urlsToPurge.join(', ')}`, 'CDNPurge');
        } catch (error) {
          logger.error('CDN purge failed', 'CDNError', { error, urls });
          throw error;
        }
      };

      res.prefetchCDN = async (urls: string[]) => {
        if (!cdnAdapter || !cdnAdapter.prefetch) {
          logger.warn('CDN prefetch requested but not supported by adapter', 'CDNPrefetch');
          return;
        }

        try {
          await cdnAdapter.prefetch(urls);
          logger.info(`CDN prefetch requested: ${urls.join(', ')}`, 'CDNPrefetch');
        } catch (error) {
          logger.error('CDN prefetch failed', 'CDNError', { error, urls });
        }
      };

      res.getCDNStats = async () => {
        if (!cdnAdapter || !cdnAdapter.getStats) {
          logger.warn('CDN stats requested but not supported by adapter', 'CDNStats');
          return null;
        }

        try {
          const stats = await cdnAdapter.getStats();
          logger.debug('CDN stats retrieved', 'CDNStats');
          return stats;
        } catch (error) {
          logger.error('CDN stats retrieval failed', 'CDNError', { error });
          return null;
        }
      };
    });

    // Auto-invalidation on certain patterns
    if (options.autoInvalidate && options.invalidationPatterns) {
      hooks.after('response', async (context: HookContext) => {
        const req = context.request as any;
        const res = context.response as any;

        // Check if this request matches invalidation patterns
        const shouldInvalidate = options.invalidationPatterns?.some(pattern => {
          const regex = new RegExp(pattern);
          return regex.test(req.path);
        });

        if (shouldInvalidate && cdnAdapter) {
          try {
            await cdnAdapter.purge([req.path]);
            logger.debug(`Auto-invalidated CDN cache for: ${req.path}`, 'CDNAutoInvalidate');
          } catch (error) {
            logger.error('CDN auto-invalidation failed', 'CDNError', {
              error,
              path: req.path,
            });
          }
        }
      });
    }

    logger.info('CDN middleware installed', 'Installation', {
      adapter: typeof options.adapter === 'string' ? options.adapter : 'custom',
      autoInvalidate: !!options.autoInvalidate,
    });
  },
});
