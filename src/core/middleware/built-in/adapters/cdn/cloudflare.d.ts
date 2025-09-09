import { CDNAdapter } from '../../../../../types/cdn';
export declare class CloudflareCDNAdapter implements CDNAdapter {
  private apiToken;
  private zoneId;
  constructor(options: { apiToken: string; zoneId: string });
  purge(urls: string[]): Promise<void>;
  prefetch(urls: string[]): Promise<void>;
  getStats(): Promise<any>;
  setHeaders(response: any): void;
  private cfRequest;
}
