// Azure CDN Adapter
import { CDNAdapter } from '../../../../../../types/cdn.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';

const logger = createFrameworkLogger('AzureCDNAdapter');

interface AzureTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class AzureCDNAdapter implements CDNAdapter {
  private endpoint: string;
  private subscriptionId: string;
  private resourceGroup: string;
  private profileName: string;
  private endpointName: string;
  private clientId?: string;
  private clientSecret?: string;
  private tenantId?: string;
  private accessToken?: string;
  private tokenExpiry?: number;
  private cacheControlMaxAge: number;

  constructor(options: {
    subscriptionId: string;
    resourceGroup: string;
    profileName: string;
    endpointName: string;
    endpoint: string;
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
    cacheControlMaxAge?: number;
  }) {
    this.subscriptionId = options.subscriptionId;
    this.resourceGroup = options.resourceGroup;
    this.profileName = options.profileName;
    this.endpointName = options.endpointName;
    this.endpoint = options.endpoint;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tenantId = options.tenantId;
    this.cacheControlMaxAge = options.cacheControlMaxAge ?? 3600;

    logger.info('Azure CDN adapter initialized', 'AzureCDN');
  }

  private async getAccessToken(): Promise<string> {
    if (!this.clientId || !this.clientSecret || !this.tenantId) {
      throw new Error(
        'Azure credentials (clientId, clientSecret, tenantId) are required for API operations'
      );
    }

    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'https://management.azure.com/.default',
        grant_type: 'client_credentials',
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get Azure access token: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as AzureTokenResponse;
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

      return this.accessToken;
    } catch (error) {
      logger.error('Failed to obtain Azure access token', 'AzureCDN', { error });
      throw error;
    }
  }

  async purge(urls: string[]): Promise<void> {
    if (!urls || urls.length === 0) {
      logger.warn('No URLs provided for purge', 'AzureCDN');
      return;
    }

    try {
      const accessToken = await this.getAccessToken();
      const purgeUrl = `https://management.azure.com/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Cdn/profiles/${this.profileName}/endpoints/${this.endpointName}/purge?api-version=2021-06-01`;

      const purgeData = {
        contentPaths: urls.map(url => (url.startsWith('/') ? url : `/${url}`)),
      };

      logger.info(`Azure CDN cache purge requested: ${urls.length} URLs`, 'AzureCDN');

      const response = await fetch(purgeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(purgeData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure CDN purge failed: ${response.status} ${errorText}`);
      }

      logger.info(`Azure CDN cache purged successfully for ${urls.length} URLs`, 'AzureCDN');
    } catch (error) {
      logger.error('Azure CDN purge failed', 'AzureCDN', { error, urls });
      throw error;
    }
  }

  async prefetch(urls: string[]): Promise<void> {
    if (!urls || urls.length === 0) {
      logger.warn('No URLs provided for prefetch', 'AzureCDN');
      return;
    }

    try {
      const accessToken = await this.getAccessToken();
      const loadUrl = `https://management.azure.com/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Cdn/profiles/${this.profileName}/endpoints/${this.endpointName}/load?api-version=2021-06-01`;

      const loadData = {
        contentPaths: urls.map(url => (url.startsWith('/') ? url : `/${url}`)),
      };

      logger.debug(`Azure CDN prefetch requested for ${urls.length} URLs`, 'AzureCDN');

      const response = await fetch(loadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(loadData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure CDN prefetch failed: ${response.status} ${errorText}`);
      }

      logger.info(`Azure CDN prefetch completed successfully for ${urls.length} URLs`, 'AzureCDN');
    } catch (error) {
      logger.error('Azure CDN prefetch failed', 'AzureCDN', { error, urls });
      throw error;
    }
  }

  setHeaders(response: any): void {
    if (!response || typeof response.setHeader !== 'function') {
      logger.warn('Invalid response object provided to setHeaders', 'AzureCDN');
      return;
    }

    response.setHeader('Cache-Control', `public, max-age=${this.cacheControlMaxAge}`);
    response.setHeader('X-CDN-Provider', 'Azure');
  }
}
