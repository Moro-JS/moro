// Module Definition Types

import type { ValidationErrorHandler } from './config.js';
import type { CompiledRoute } from '../core/routing/index.js';

// Middleware can be a string name (resolved from built-in) or actual function
export type ModuleMiddleware =
  string | ((req: any, res: any, next: (err?: unknown) => void) => void | Promise<void>);

export interface ModuleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (req: any, res: any) => any | Promise<any>;
  validation?: any;
  onValidationError?: ValidationErrorHandler;
  cache?: { ttl?: number; key?: string | ((req: any) => string); shared?: boolean };
  rateLimit?: { requests: number; window: number };
  middleware?: ModuleMiddleware[]; // Support both strings and functions
  auth?: {
    roles?: string[];
    permissions?: string[];
    optional?: boolean;
    /**
     * Sign-in is required, which it already is unless `optional` is true.
     * With a `validator` it makes a denial of a request that has no
     * authenticated user a 401 instead of a 403.
     */
    required?: boolean;
    /**
     * A check of this request beyond roles and permissions (for example that
     * the signed-in user owns the record named in the path). Called with the
     * request after the sign-in, role and permission checks; may return a
     * promise. A falsy result or a throw denies the request.
     */
    validator?: (req: any) => unknown;
  };
}

export interface ModuleSocket {
  event: string;
  handler: (socket: any, data: any) => any | Promise<any>;
  validation?: any;
  rateLimit?: { requests: number; window: number };
  rooms?: string[];
  broadcast?: boolean;
}

export interface ModuleDefinition {
  name: string;
  version: string;
  config?: {
    cache?: { ttl: number };
    rateLimit?: { requests: number; window: number };
    database?: {
      path?: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
  routes?: (ModuleRoute | CompiledRoute)[];
  sockets?: ModuleSocket[];
  dependencies?: string[];
  middleware?: ModuleMiddleware[]; // Module-level middleware (applied to all routes)
}

// Internal Module Configuration (used by framework)
export interface ModuleConfig {
  name: string;
  version: string;
  routes?: InternalRouteDefinition[];
  websockets?: WebSocketDefinition[];
  sockets?: WebSocketDefinition[];
  dependencies?: string[];
  middleware?: any[]; // MiddlewareFunction from http types
  services?: ServiceDefinition[];
  config?: any; // Module-specific configuration
  routeHandlers?: Record<string, CallableFunction>;
  socketHandlers?: Record<string, CallableFunction>;
}

export interface InternalRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: string;
  middleware?: ModuleMiddleware[]; // Support both strings and functions
  validation?: any;
  onValidationError?: ValidationErrorHandler;
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  auth?: {
    roles?: string[];
    permissions?: string[];
    optional?: boolean;
    required?: boolean;
    validator?: (req: any) => unknown;
  };
  // Allow additional properties for extensibility
  [key: string]: any;
}

export interface WebSocketDefinition {
  event: string;
  handler: string;
  middleware?: string[];
  validation?: any;
  rateLimit?: RateLimitConfig;
  rooms?: string[];
  broadcast?: boolean;
}

export interface ServiceDefinition {
  name: string;
  implementation: new (...args: any[]) => any;
  /** Has no effect: a module service is one instance for the app either way. */
  singleton?: boolean;
  dependencies?: string[];
}

export interface CacheConfig {
  /** Seconds a stored response is served for. Left out: `modules.cache.defaultTtl`. */
  ttl?: number;
  /** A fixed key, or a function of the request. Used exactly as given. */
  key?: string | ((req: any) => string);
  /** The response is identical for every signed-in user; share one entry. */
  shared?: boolean;
}

export interface RateLimitConfig {
  requests: number;
  window: number;
}
