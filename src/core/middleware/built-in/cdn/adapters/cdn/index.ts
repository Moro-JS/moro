// CDN Adapters
export { CloudflareCDNAdapter } from './cloudflare.js';
export { CloudFrontCDNAdapter } from './cloudfront.js';
export { AzureCDNAdapter } from './azure.js';

import { CloudflareCDNAdapter } from './cloudflare.js';
import { CloudFrontCDNAdapter } from './cloudfront.js';
import { AzureCDNAdapter } from './azure.js';
import { CDNAdapter } from '../../../../../../types/cdn.js';

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
