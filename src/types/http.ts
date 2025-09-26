// HTTP Server Types
import { IncomingMessage, ServerResponse } from 'http';

export interface HttpRequest extends IncomingMessage {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  path: string;
  headers: Record<string, string>;
  ip: string;
  requestId: string;
  cookies?: Record<string, string>;
  files?: Record<string, any>;
  [key: string]: any;
}

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  domain?: string;
  path?: string;
  // Security options
  critical?: boolean; // Mark as critical for security (throws on late set)
  throwOnLateSet?: boolean; // Force throw if headers already sent
}

export interface ResponseState {
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, any>;
  finished: boolean;
  writable: boolean;
}

export interface MoroResponseMethods {
  json(data: any): void;
  status(code: number): HttpResponse;
  send(data: string | Buffer): void;
  cookie(name: string, value: string, options?: CookieOptions): HttpResponse;
  clearCookie(name: string, options?: CookieOptions): HttpResponse;
  redirect(url: string, status?: number): void;
  sendFile(filePath: string): Promise<void>;
  render?(template: string, data?: any): Promise<void>;

  // Header management utilities
  hasHeader(name: string): boolean;
  setBulkHeaders(headers: Record<string, string | number>): HttpResponse;
  appendHeader(name: string, value: string | string[]): HttpResponse;

  // Response state utilities
  canSetHeaders(): boolean;
  getResponseState(): ResponseState;
}

export type HttpResponse = ServerResponse & MoroResponseMethods;

export type HttpHandler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void
) => Promise<void> | void;
export type MiddlewareFunction = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void
) => void | Promise<void>;

// Internal router types
export interface RouteEntry {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HttpHandler;
  middleware: Middleware[];
}

export interface RouteDefinition {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HttpHandler;
  middleware: Middleware[];
}
