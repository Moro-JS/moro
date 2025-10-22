// CDN Core - Reusable CDN logic with adapter support
import { HttpResponse } from '../../../../types/http.js';
import { CDNAdapter, CDNOptions } from '../../../../types/cdn.js';
import { createCDNAdapter } from '../cdn/adapters/cdn/index.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('CDNCore');

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
   * Auto-invalidate CDN cache for a path if it matches patterns
   */
  async autoInvalidate(path: string): Promise<void> {
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
