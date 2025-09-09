import { HttpRequest, HttpResponse } from './http';
export type RuntimeType = 'node' | 'vercel-edge' | 'aws-lambda' | 'cloudflare-workers';
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
export type NodeHandler = (req: any, res: any) => Promise<void> | void;
export type EdgeHandler = (request: Request) => Promise<Response>;
export type LambdaHandler = (event: any, context: any) => Promise<any>;
export type WorkerHandler = (request: Request, env: any, ctx: any) => Promise<Response>;
export interface RuntimeAdapter {
  readonly type: RuntimeType;
  adaptRequest(runtimeRequest: any, ...args: any[]): Promise<HttpRequest>;
  adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    runtimeRequest: any
  ): Promise<any>;
  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): any;
  listen?(server: any, port: number, host?: string, callback?: () => void): void;
}
export interface RuntimeConfig {
  type: RuntimeType;
  adapter?: RuntimeAdapter;
  options?: any;
}
export interface RuntimeMoroOptions {
  runtime?: RuntimeConfig;
}
