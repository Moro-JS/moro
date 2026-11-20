// CDN Core - Reusable CDN logic with adapter support
import { HttpResponse } from '../../../../types/http.js';
import { CDNAdapter, CDNOptions } from '../../../../types/cdn.js';
import { createCDNAdapter } from '../cdn/adapters/cdn/index.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('CDNCore');

/** Response methods that send (or start sending) the head, on every backend */
const HEAD_SENDERS = ['writeHead', 'write', 'end', 'json', 'send', 'redirect'] as const;

/** A status a CDN may be told to keep: success, or the 304 that revalidates one */
function isCacheableStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

/** True when headers handed to writeHead() include a Set-Cookie */
function carriesSetCookie(headers: unknown): boolean {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return false;
  for (const name of Object.keys(headers as Record<string, unknown>)) {
    if (name.toLowerCase() === 'set-cookie') return true;
  }
  return false;
}

/**
 * Take the adapter's Cache-Control back off the response if, by the time the
 * head is sent, the response turned out not to be one a CDN should keep: a
 * status outside 2xx/304, or one that sets a cookie. A Cache-Control the
 * handler set in the meantime is the handler's and is left alone.
 *
 * The status and the cookies are only known when the handler has run, so the
 * check sits in front of the methods that send the head. It runs once.
 */
function withdrawUnlessCacheable(res: any, applied: unknown): void {
  let settled = false;
  const settle = (status: number, headers?: unknown) => {
    settled = true;
    if (res.getHeader('Cache-Control') !== applied) return;
    if (
      isCacheableStatus(status) &&
      res.getHeader('Set-Cookie') === undefined &&
      !carriesSetCookie(headers)
    ) {
      return;
    }
    res.removeHeader('Cache-Control');
  };

  for (const name of HEAD_SENDERS) {
    const original = res[name];
    if (typeof original !== 'function') continue;
    res[name] = function (this: any, a?: any, b?: any, c?: any) {
      if (!settled) {
        if (name === 'writeHead') {
          // writeHead(status, [reason], [headers]) carries both itself
          settle(typeof a === 'number' ? a : res.statusCode, typeof b === 'object' ? b : c);
        } else if (name === 'redirect') {
          settle(typeof b === 'number' ? b : 302);
        } else {
          settle(res.statusCode);
        }
      }
      return original.call(this, a, b, c);
    };
  }
}

// ===== Core Logic =====

/**
 * CDNCore - Core CDN management logic with adapter pattern
 * Used directly by the router for route-based CDN handling
 */
export class CDNCore {
  private adapter: CDNAdapter | null = null;
  private options: CDNOptions;

  constructor(options: CDNOptions = {}) {
    this.options = options;
    this.initializeAdapter();
  }

  /**
   * Initialize the CDN adapter
   */
  private initializeAdapter(): void {
    if (!this.options.adapter) {
      return;
    }

    // If adapter is already a CDNAdapter instance
    if (typeof this.options.adapter === 'object' && 'purge' in this.options.adapter) {
      this.adapter = this.options.adapter as CDNAdapter;
      return;
    }

    // If adapter is a string, use factory to create it
    if (typeof this.options.adapter === 'string') {
      try {
        this.adapter = createCDNAdapter(this.options.adapter, this.options.adapterOptions);
      } catch (error) {
        logger.error('Failed to initialize CDN adapter', 'Initialization', { error });
      }
    }
  }

  /**
   * Check if adapter is available
   */
  hasAdapter(): boolean {
    return this.adapter !== null;
  }

  /**
   * Set CDN headers on response
   */
  setHeaders(res: HttpResponse): void {
    if (!this.adapter) {
      return;
    }
    this.adapter.setHeaders(res);
  }

  /**
   * Set CDN headers for one request/response pair. The adapter's own headers
   * go on as with setHeaders(); its `Cache-Control` (a public, shared-cache
   * lifetime) stays only when the exchange is one a CDN may keep for
   * everyone:
   *   - the method is GET or HEAD
   *   - the request carries no Authorization header
   *   - nothing set a Cache-Control before, and the handler sets none after
   *   - the response status is 2xx or 304
   *   - the response sets no cookie
   * The last three are checked when the head is sent.
   */
  applyHeaders(req: { method?: string; headers?: Record<string, any> }, res: any): void {
    if (!this.adapter) {
      return;
    }
    if (
      !res ||
      typeof res.getHeader !== 'function' ||
      typeof res.setHeader !== 'function' ||
      typeof res.removeHeader !== 'function'
    ) {
      // Not a response whose headers can be inspected: nothing can be decided
      this.adapter.setHeaders(res);
      return;
    }

    const prior = res.getHeader('Cache-Control');
    this.adapter.setHeaders(res);
    const applied = res.getHeader('Cache-Control');
    if (applied === undefined || applied === prior) {
      return; // the adapter set no Cache-Control of its own
    }

    const method = req.method;
    const shareable =
      (method === 'GET' || method === 'HEAD') &&
      req.headers?.authorization === undefined &&
      prior === undefined;

    if (!shareable) {
      // Put back what was there before the adapter
      if (prior === undefined) res.removeHeader('Cache-Control');
      else res.setHeader('Cache-Control', prior);
      return;
    }

    withdrawUnlessCacheable(res, applied);
  }

  /**
   * Purge CDN cache for given URLs
   */
  async purge(urls: string[]): Promise<void> {
    if (!this.adapter) {
      logger.warn('CDN purge requested but no adapter configured', 'CDNPurge');
      return;
    }

    try {
      await this.adapter.purge(urls);
      logger.info(`CDN cache purged: ${urls.join(', ')}`, 'CDNPurge');
    } catch (error) {
      logger.error('CDN purge failed', 'CDNError', { error, urls });
      throw error;
    }
  }

  /**
   * Prefetch URLs to CDN cache
   */
  async prefetch(urls: string[]): Promise<void> {
    if (!this.adapter) {
      logger.warn('CDN prefetch requested but no adapter configured', 'CDNPrefetch');
      return;
    }

    if (!this.adapter.prefetch) {
      logger.warn('CDN prefetch requested but not supported by adapter', 'CDNPrefetch');
      return;
    }

    try {
      await this.adapter.prefetch(urls);
      logger.info(`CDN prefetch requested: ${urls.join(', ')}`, 'CDNPrefetch');
    } catch (error) {
      logger.error('CDN prefetch failed', 'CDNError', { error, urls });
      throw error;
    }
  }

  /**
   * Get CDN statistics
   */
  async getStats(): Promise<any> {
    if (!this.adapter) {
      logger.warn('CDN stats requested but no adapter configured', 'CDNStats');
      return null;
    }

    if (!this.adapter.getStats) {
      logger.warn('CDN stats requested but not supported by adapter', 'CDNStats');
      return null;
    }

    try {
      const stats = await this.adapter.getStats();
      logger.debug('CDN stats retrieved', 'CDNStats');
      return stats;
    } catch (error) {
      logger.error('CDN stats retrieval failed', 'CDNError', { error });
      return null;
    }
  }

  /**
   * Check if path matches invalidation patterns
   */
  shouldAutoInvalidate(path: string): boolean {
    if (!this.options.autoInvalidate || !this.options.invalidationPatterns) {
      return false;
    }

    return this.options.invalidationPatterns.some(pattern => {
      const regex = new RegExp(pattern);
      return regex.test(path);
    });
  }

  /**
   * Auto-invalidate CDN cache for a path if it matches patterns.
   *
   * With `method` and `statusCode` (what the built-in hook and middleware
   * pass), the purge only follows a request that can have changed something:
   * a method other than GET/HEAD/OPTIONS that was answered below 400. Reads
   * and failed writes change nothing at the origin, and purging on them let
   * any client spend the provider's purge quota.
   */
  async autoInvalidate(path: string, method?: string, statusCode?: number): Promise<void> {
    if (method !== undefined) {
      const m = method.toUpperCase();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
        return;
      }
    }
    if (statusCode !== undefined && statusCode >= 400) {
      return;
    }

    if (!this.shouldAutoInvalidate(path)) {
      return;
    }

    if (!this.adapter) {
      return;
    }

    try {
      await this.adapter.purge([path]);
      logger.debug(`Auto-invalidated CDN cache for: ${path}`, 'CDNAutoInvalidate');
    } catch (error) {
      logger.error('CDN auto-invalidation failed', 'CDNError', { error, path });
    }
  }
}
