// Runtime abstraction types for multi-environment support
import { HttpRequest, HttpResponse } from './http';

export type RuntimeType = 'node' | 'vercel-edge' | 'aws-lambda' | 'cloudflare-workers';

// Generic runtime request/response interfaces
export interface RuntimeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
  params?: Record<string, string>;
  [key: string]: any;
}

export interface RuntimeResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

// Runtime-specific response interface for adapters
export interface RuntimeHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  headersSent: boolean;

  status(code: number): RuntimeHttpResponse;
  json(data: any): void;
  send(data: string | Buffer): void;
  cookie(name: string, value: string, options?: any): RuntimeHttpResponse;
  clearCookie(name: string, options?: any): RuntimeHttpResponse;
  redirect(url: string, status?: number): void;
  sendFile?(filePath: string): Promise<void>;
}

// Runtime-specific handler types
export type NodeHandler = (req: any, res: any) => Promise<void> | void;
export type EdgeHandler = (request: Request) => Promise<Response>;
export type LambdaHandler = (event: any, context: any) => Promise<any>;
export type WorkerHandler = (request: Request, env: any, ctx: any) => Promise<Response>;

// Runtime adapter interface
export interface RuntimeAdapter {
  readonly type: RuntimeType;

  // Convert runtime-specific request to MoroJS HttpRequest
  adaptRequest(runtimeRequest: any, ...args: any[]): Promise<HttpRequest>;

  // Convert MoroJS HttpResponse to runtime-specific response
  adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    runtimeRequest: any
  ): Promise<any>;

  // Create the appropriate server/handler for the runtime
  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): any;

  // Start listening (for runtimes that support it)
  listen?(server: any, port: number, host?: string, callback?: () => void): void;
}

// Runtime configuration
export interface RuntimeConfig {
  type: RuntimeType;
  adapter?: RuntimeAdapter;
  options?: any;
}

// Extended MoroOptions to include runtime configuration
export interface RuntimeMoroOptions {
  runtime?: RuntimeConfig;
  // ... existing options
}
