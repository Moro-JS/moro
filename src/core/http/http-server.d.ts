import { Server } from 'http';
import { HttpHandler, Middleware } from '../../types/http';
export declare class MoroHttpServer {
  private server;
  private routes;
  private globalMiddleware;
  private compressionEnabled;
  private compressionThreshold;
  private logger;
  constructor();
  use(middleware: Middleware): void;
  get(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  post(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  put(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  delete(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  patch(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  private addRoute;
  private pathToRegex;
  private handleRequest;
  private enhanceRequest;
  private parseCookies;
  private enhanceResponse;
  private getMimeType;
  private addCharsetIfNeeded;
  private parseBody;
  private parseMultipart;
  private parseUrlEncoded;
  private findRoute;
  private executeMiddleware;
  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  close(): Promise<void>;
  getServer(): Server;
}
export declare const middleware: {
  cors: (options?: { origin?: string; credentials?: boolean }) => Middleware;
  helmet: () => Middleware;
  compression: (options?: { threshold?: number; level?: number }) => Middleware;
  requestLogger: () => Middleware;
  bodySize: (options?: { limit?: string }) => Middleware;
  static: (options: {
    root: string;
    maxAge?: number;
    index?: string[];
    dotfiles?: 'allow' | 'deny' | 'ignore';
    etag?: boolean;
  }) => Middleware;
  upload: (options?: {
    dest?: string;
    maxFileSize?: number;
    maxFiles?: number;
    allowedTypes?: string[];
  }) => Middleware;
  template: (options: {
    views: string;
    engine?: 'moro' | 'handlebars' | 'ejs';
    cache?: boolean;
    defaultLayout?: string;
  }) => Middleware;
  http2Push: (options?: {
    resources?: Array<{
      path: string;
      as: string;
      type?: string;
    }>;
    condition?: (req: any) => boolean;
  }) => Middleware;
  sse: (options?: { heartbeat?: number; retry?: number; cors?: boolean }) => Middleware;
  range: (options?: { acceptRanges?: string; maxRanges?: number }) => Middleware;
  csrf: (options?: {
    secret?: string;
    tokenLength?: number;
    cookieName?: string;
    headerName?: string;
    ignoreMethods?: string[];
    sameSite?: boolean;
  }) => Middleware;
  csp: (options?: {
    directives?: {
      defaultSrc?: string[];
      scriptSrc?: string[];
      styleSrc?: string[];
      imgSrc?: string[];
      connectSrc?: string[];
      fontSrc?: string[];
      objectSrc?: string[];
      mediaSrc?: string[];
      frameSrc?: string[];
      childSrc?: string[];
      workerSrc?: string[];
      formAction?: string[];
      upgradeInsecureRequests?: boolean;
      blockAllMixedContent?: boolean;
    };
    reportOnly?: boolean;
    reportUri?: string;
    nonce?: boolean;
  }) => Middleware;
};
