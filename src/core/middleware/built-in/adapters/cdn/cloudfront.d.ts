import { CDNAdapter } from '../../../../../types/cdn';
export declare class CloudFrontCDNAdapter implements CDNAdapter {
  private cloudfront;
  private distributionId;
  constructor(options: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    distributionId: string;
  });
  purge(urls: string[]): Promise<void>;
  prefetch(urls: string[]): Promise<void>;
  getStats(): Promise<any>;
  setHeaders(response: any): void;
}
