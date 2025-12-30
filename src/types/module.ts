// Module Definition Types

// Middleware can be a string name (resolved from built-in) or actual function
export type ModuleMiddleware =
  | string
  | ((req: any, res: any, next: () => void) => void | Promise<void>);

export interface ModuleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (req: any, res: any) => any | Promise<any>;
  validation?: any;
  cache?: { ttl: number; key?: string };
  rateLimit?: { requests: number; window: number };
  middleware?: ModuleMiddleware[]; // Support both strings and functions
  auth?: {
    roles?: string[];
    permissions?: string[];
    optional?: boolean;
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
    };
    [key: string]: any;
  };
  routes?: ModuleRoute[];
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
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  auth?: {
    roles?: string[];
    permissions?: string[];
    optional?: boolean;
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
  singleton?: boolean;
  dependencies?: string[];
}

export interface CacheConfig {
  ttl: number;
  key?: string;
}

export interface RateLimitConfig {
  requests: number;
  window: number;
}
