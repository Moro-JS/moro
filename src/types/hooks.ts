// Hooks and Middleware Types
import { HttpRequest, HttpResponse } from '../core/http/index.js';

export type HookFunction = (...args: any[]) => Promise<any> | any;

export interface StandardMiddleware {
  (req: HttpRequest, res: HttpResponse, next: () => Promise<void>): Promise<void> | void;
}

export interface HookContext {
  request?: HttpRequest;
  response?: HttpResponse;
  data?: any;
  metadata?: Record<string, any>;
}

export interface MoroMiddleware {
  name: string;
  version?: string;
  install: (hooks: any, options?: any) => Promise<void> | void;
  uninstall?: (hooks: any) => Promise<void> | void;
}

// Advanced middleware types
export interface MiddlewareMetadata {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  dependencies?: string[];
  tags?: string[];
}

export interface MiddlewareContext {
  app: any;
  hooks: any; // HookManager
  config: any;
  logger?: any;
}

export interface MiddlewareInterface extends MoroMiddleware {
  metadata?: MiddlewareMetadata;
  dependencies?: string[];
  configure?: (config: any) => void;
  beforeInstall?: (context: MiddlewareContext) => Promise<void> | void;
  afterInstall?: (context: MiddlewareContext) => Promise<void> | void;
  beforeUninstall?: (context: MiddlewareContext) => Promise<void> | void;
  afterUninstall?: (context: MiddlewareContext) => Promise<void> | void;
}

export type SimpleMiddlewareFunction = (app: any) => Promise<void> | void;
