import { CDNAdapter } from '../../../../../types/cdn';
export declare class AzureCDNAdapter implements CDNAdapter {
  private endpoint;
  private subscriptionId;
  private resourceGroup;
  private profileName;
  private endpointName;
  constructor(options: {
    subscriptionId: string;
    resourceGroup: string;
    profileName: string;
    endpointName: string;
    endpoint: string;
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
  });
  purge(urls: string[]): Promise<void>;
  prefetch(urls: string[]): Promise<void>;
  setHeaders(response: any): void;
}
