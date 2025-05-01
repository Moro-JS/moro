// HTTP Server Types
import { IncomingMessage, ServerResponse } from "http";

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
  sameSite?: "strict" | "lax" | "none";
  domain?: string;
  path?: string;
}

export interface HttpResponse extends ServerResponse {
  json(data: any): void;
  status(code: number): HttpResponse;
  send(data: string | Buffer): void;
  cookie(name: string, value: string, options?: CookieOptions): HttpResponse;
  clearCookie(name: string, options?: CookieOptions): HttpResponse;
  redirect(url: string, status?: number): void;
  sendFile(filePath: string): Promise<void>;
  render?(template: string, data?: any): Promise<void>;
}

export type HttpHandler = (
  req: HttpRequest,
  res: HttpResponse,
) => Promise<void> | void;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void,
) => Promise<void> | void;
export type MiddlewareFunction = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void,
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
