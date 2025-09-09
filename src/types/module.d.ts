export interface ModuleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (req: any, res: any) => any | Promise<any>;
  validation?: any;
  cache?: {
    ttl: number;
    key?: string;
  };
  rateLimit?: {
    requests: number;
    window: number;
  };
  middleware?: string[];
}
export interface ModuleSocket {
  event: string;
  handler: (socket: any, data: any) => any | Promise<any>;
  validation?: any;
  rateLimit?: {
    requests: number;
    window: number;
  };
  rooms?: string[];
  broadcast?: boolean;
}
export interface ModuleDefinition {
  name: string;
  version: string;
  config?: {
    cache?: {
      ttl: number;
    };
    rateLimit?: {
      requests: number;
      window: number;
    };
    database?: {
      path?: string;
    };
    [key: string]: any;
  };
  routes?: ModuleRoute[];
  sockets?: ModuleSocket[];
  dependencies?: string[];
}
export interface ModuleConfig {
  name: string;
  version: string;
  routes?: InternalRouteDefinition[];
  websockets?: WebSocketDefinition[];
  sockets?: WebSocketDefinition[];
  dependencies?: string[];
  middleware?: any[];
  services?: ServiceDefinition[];
  config?: any;
  routeHandlers?: Record<string, Function>;
  socketHandlers?: Record<string, Function>;
}
export interface InternalRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: string;
  middleware?: string[];
  validation?: any;
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
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
