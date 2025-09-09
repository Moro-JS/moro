// CDN Adapters
export { CloudflareCDNAdapter } from './cloudflare';
export { CloudFrontCDNAdapter } from './cloudfront';
export { AzureCDNAdapter } from './azure';

import { CloudflareCDNAdapter } from './cloudflare';
import { CloudFrontCDNAdapter } from './cloudfront';
import { AzureCDNAdapter } from './azure';
import { CDNAdapter } from '../../../../../types/cdn';

// Adapter factory function for auto-loading
export function createCDNAdapter(type: string, options: any = {}): CDNAdapter {
  switch (type.toLowerCase()) {
    case 'cloudflare':
      return new CloudflareCDNAdapter(options);
    case 'cloudfront':
      return new CloudFrontCDNAdapter(options);
    case 'azure':
      return new AzureCDNAdapter(options);
    default:
      throw new Error(`Unknown CDN adapter type: ${type}`);
  }
}
