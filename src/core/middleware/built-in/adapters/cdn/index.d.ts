export { CloudflareCDNAdapter } from './cloudflare';
export { CloudFrontCDNAdapter } from './cloudfront';
export { AzureCDNAdapter } from './azure';
import { CDNAdapter } from '../../../../../types/cdn';
export declare function createCDNAdapter(type: string, options?: any): CDNAdapter;
