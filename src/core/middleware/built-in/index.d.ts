export { auth } from './auth';
export { rateLimit } from './rate-limit';
export { cors } from './cors';
export { validation } from './validation';
export { requestLogger } from './request-logger';
export { performanceMonitor } from './performance-monitor';
export { errorTracker } from './error-tracker';
export { cookie } from './cookie';
export { csrf } from './csrf';
export { csp } from './csp';
export { sse } from './sse';
export { session } from './session';
export { cache } from './cache';
export { cdn } from './cdn';
export declare const builtInMiddleware: {
  auth: (options?: any) => import('..').MiddlewareInterface;
  rateLimit: (options?: {
    windowMs?: number;
    max?: number;
    message?: string;
  }) => import('..').MiddlewareInterface;
  cors: (options?: any) => import('..').MiddlewareInterface;
  validation: () => import('..').MiddlewareInterface;
  cookie: (options?: { secret?: string; signed?: boolean }) => import('..').MiddlewareInterface;
  csrf: (options?: {
    secret?: string;
    tokenLength?: number;
    cookieName?: string;
    headerName?: string;
    ignoreMethods?: string[];
    sameSite?: boolean;
  }) => import('..').MiddlewareInterface;
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
  }) => import('..').MiddlewareInterface;
  sse: (options?: {
    heartbeat?: number;
    retry?: number;
    cors?: boolean;
  }) => import('..').MiddlewareInterface;
  session: (options?: import('./session').SessionOptions) => import('..').MiddlewareInterface;
  cache: (options?: import('../../..').CacheOptions) => import('..').MiddlewareInterface;
  cdn: (options?: import('../../..').CDNOptions) => import('..').MiddlewareInterface;
};
export declare const simpleMiddleware: {
  requestLogger: (context: any) => Promise<void>;
  performanceMonitor: (context: any) => Promise<void>;
  errorTracker: (context: any) => Promise<void>;
};
