export interface CDNAdapter {
  purge(urls: string[]): Promise<void>;
  prefetch?(urls: string[]): Promise<void>;
  getStats?(): Promise<any>;
  setHeaders(response: any): void;
}
export interface CDNOptions {
  adapter?: string | CDNAdapter;
  adapterOptions?: any;
  autoInvalidate?: boolean;
  invalidationPatterns?: string[];
}
export interface CDNStats {
  provider: string;
  status: string;
  lastPurge?: Date;
  hitRate?: string;
  bandwidth?: string;
}
