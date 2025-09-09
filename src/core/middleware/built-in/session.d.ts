import { MiddlewareInterface } from '../../../types/hooks';
import { CacheAdapter } from '../../../types/cache';
export interface SessionOptions {
  store?: 'memory' | 'redis' | 'file' | CacheAdapter;
  storeOptions?: {
    host?: string;
    port?: number;
    password?: string;
    keyPrefix?: string;
    path?: string;
    max?: number;
  };
  secret?: string;
  name?: string;
  genid?: () => string;
  rolling?: boolean;
  resave?: boolean;
  saveUninitialized?: boolean;
  cookie?: {
    maxAge?: number;
    expires?: Date;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    domain?: string;
    path?: string;
  };
  proxy?: boolean;
  unset?: 'destroy' | 'keep';
}
export interface SessionData {
  [key: string]: any;
  cookie?: {
    originalMaxAge?: number;
    expires?: Date;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
  };
}
export declare const session: (options?: SessionOptions) => MiddlewareInterface;
