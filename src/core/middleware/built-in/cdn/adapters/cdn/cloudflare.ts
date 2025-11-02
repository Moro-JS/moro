// Cloudflare CDN Adapter
import { CDNAdapter } from '../../../../../../types/cdn.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';

const logger = createFrameworkLogger('CloudflareCDNAdapter');

interface CloudflareResponse<T = any> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

export class CloudflareCDNAdapter implements CDNAdapter {
  private apiToken: string;
  private zoneId: string;
  private cacheControlMaxAge: number;
  private email?: string;

  constructor(options: {
    apiToken: string;
    zoneId: string;
    email?: string;
    cacheControlMaxAge?: number;
  }) {
    this.apiToken = options.apiToken;
    this.zoneId = options.zoneId;
    this.email = options.email;
    this.cacheControlMaxAge = options.cacheControlMaxAge ?? 3600;

    logger.info('Cloudflare CDN adapter initialized', 'Cloudflare');
  }

  async purge(urls: string[]): Promise<void> {
    if (!urls || urls.length === 0) {
      logger.warn('No URLs provided for purge', 'Cloudflare');
      return;
    }

    try {
      const response = await this.cfRequest<{ id: string }>(
        'POST',
        `/zones/${this.zoneId}/purge_cache`,
        {
          files: urls,
        }
      );

      if (response.success) {
        logger.info(`Cloudflare cache purged: ${urls.length} URLs`, 'Cloudflare');
      } else {
        const errorMessages = response.errors?.map(e => e.message).join(', ') || 'Unknown error';
        throw new Error(`Cloudflare purge failed: ${errorMessages}`);
      }
    } catch (error) {
      logger.error('Cloudflare purge failed', 'Cloudflare', { error, urls });
      throw error;
    }
  }

  async purgeEverything(): Promise<void> {
    try {
      const response = await this.cfRequest<{ id: string }>(
        'POST',
        `/zones/${this.zoneId}/purge_cache`,
        {
          purge_everything: true,
        }
      );

      if (response.success) {
        logger.info('Cloudflare entire cache purged', 'Cloudflare');
      } else {
        const errorMessages = response.errors?.map(e => e.message).join(', ') || 'Unknown error';
        throw new Error(`Cloudflare purge everything failed: ${errorMessages}`);
      }
    } catch (error) {
      logger.error('Cloudflare purge everything failed', 'Cloudflare', { error });
      throw error;
    }
  }

  async purgeByTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) {
      logger.warn('No tags provided for purge', 'Cloudflare');
      return;
    }

    try {
      const response = await this.cfRequest<{ id: string }>(
        'POST',
        `/zones/${this.zoneId}/purge_cache`,
        {
          tags: tags,
        }
      );

      if (response.success) {
        logger.info(`Cloudflare cache purged by tags: ${tags.join(', ')}`, 'Cloudflare');
      } else {
        const errorMessages = response.errors?.map(e => e.message).join(', ') || 'Unknown error';
        throw new Error(`Cloudflare purge by tags failed: ${errorMessages}`);
      }
    } catch (error) {
      logger.error('Cloudflare purge by tags failed', 'Cloudflare', { error, tags });
      throw error;
    }
  }

  async prefetch(urls: string[]): Promise<void> {
    if (!urls || urls.length === 0) {
      logger.warn('No URLs provided for prefetch', 'Cloudflare');
      return;
    }

    logger.info(
      `Cloudflare prefetch requested for ${urls.length} URLs. Note: Cloudflare does not have a direct prefetch API. Consider using Cache Reserve or Workers for cache warming.`,
      'Cloudflare'
    );

    try {
      for (const url of urls) {
        if (!url) {
          continue;
        }

        await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'MoroJS-Cloudflare-Prefetch/1.0',
          },
        });
      }

      logger.info(`Cloudflare prefetch completed for ${urls.length} URLs`, 'Cloudflare');
    } catch (error) {
      logger.error('Cloudflare prefetch failed', 'Cloudflare', { error, urls });
      throw error;
    }
  }

  async getStats(): Promise<any> {
    try {
      const response = await this.cfRequest<any>(
        'GET',
        `/zones/${this.zoneId}/analytics/dashboard`
      );

      if (response.success) {
        return response.result;
      }

      logger.warn('Failed to get Cloudflare stats', 'Cloudflare', { errors: response.errors });
      return null;
    } catch (error) {
      logger.error('Cloudflare stats failed', 'Cloudflare', { error });
      return null;
    }
  }

  setHeaders(response: any): void {
    if (!response || typeof response.setHeader !== 'function') {
      logger.warn('Invalid response object provided to setHeaders', 'Cloudflare');
      return;
    }

    response.setHeader('Cache-Control', `public, max-age=${this.cacheControlMaxAge}`);
    response.setHeader('X-CDN-Provider', 'Cloudflare');
  }

  private async cfRequest<T = any>(
    method: string,
    endpoint: string,
    data?: any
  ): Promise<CloudflareResponse<T>> {
    const url = `https://api.cloudflare.com/client/v4${endpoint}`;

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };

      if (this.email) {
        headers['X-Auth-Email'] = this.email;
      }

      const options: any = {
        method,
        headers,
      };

      if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloudflare API request failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as CloudflareResponse<T>;

      return result;
    } catch (error) {
      logger.error('Cloudflare API request failed', 'Cloudflare', {
        error,
        method,
        endpoint,
      });
      throw error;
    }
  }
}
