// HTTP/2 Server Implementation for Moro Framework
import {
  createSecureServer as createHttp2SecureServer,
  createServer as createHttp2Server,
  Http2Server,
  Http2SecureServer,
  ServerHttp2Stream,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from 'http2';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { createFrameworkLogger } from '../logger/index.js';
import {
  HttpRequest,
  HttpResponse,
  Middleware,
  HttpHandler,
  RouteEntry,
} from '../../types/http.js';
import { PathMatcher } from '../routing/path-matcher.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);

export interface Http2ServerOptions {
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer;
  allowHTTP1?: boolean;
  maxSessionMemory?: number;
  settings?: {
    headerTableSize?: number;
    enablePush?: boolean;
    initialWindowSize?: number;
    maxFrameSize?: number;
    maxConcurrentStreams?: number;
    maxHeaderListSize?: number;
    maxHeaderSize?: number;
    enableConnectProtocol?: boolean;
  };
}

export class MoroHttp2Server {
  private server: Http2Server | Http2SecureServer;
  private routes: RouteEntry[] = [];
  private globalMiddleware: Middleware[] = [];
  private compressionEnabled = true;
  private compressionThreshold = 1024;
  private requestTrackingEnabled = true;
  private logger = createFrameworkLogger('Http2Server');
  private hookManager: any;
  private requestCounter = 0;
  private isSecure: boolean;

  // Use shared object pool manager
  private poolManager = ObjectPoolManager.getInstance();

  // Interned method strings for fast comparison
  private static readonly METHOD_POST = 'POST';
  private static readonly METHOD_PUT = 'PUT';
  private static readonly METHOD_PATCH = 'PATCH';
  private static readonly METHOD_GET = 'GET';
  private static readonly METHOD_DELETE = 'DELETE';
  private static readonly METHOD_HEAD = 'HEAD';
  private static readonly METHOD_OPTIONS = 'OPTIONS';

  // Pre-compiled response templates
  private static readonly RESPONSE_TEMPLATES = {
    notFound: Buffer.from('{"success":false,"error":"Not found"}'),
    unauthorized: Buffer.from('{"success":false,"error":"Unauthorized"}'),
    forbidden: Buffer.from('{"success":false,"error":"Forbidden"}'),
    internalError: Buffer.from('{"success":false,"error":"Internal server error"}'),
    methodNotAllowed: Buffer.from('{"success":false,"error":"Method not allowed"}'),
    rateLimited: Buffer.from('{"success":false,"error":"Rate limit exceeded"}'),
  };

  // Route optimization structures
  private routeCache = new Map<string, RouteEntry | null>();
  private staticRoutes = new Map<string, RouteEntry>();
  private dynamicRoutes: RouteEntry[] = [];
  private routesBySegmentCount = new Map<number, RouteEntry[]>();
  private pathNormalizationCache = new Map<string, string>();

  constructor(options: Http2ServerOptions = {}) {
    this.isSecure = !!(options.key && options.cert);

    const serverOptions: any = {
      allowHTTP1: options.allowHTTP1 !== false,
    };

    // Add SSL options if secure
    if (this.isSecure) {
      serverOptions.key = options.key;
      serverOptions.cert = options.cert;
      if (options.ca) {
        serverOptions.ca = options.ca;
      }
    }

    // Add HTTP/2 settings
    if (options.settings) {
      serverOptions.settings = {
        headerTableSize: options.settings.headerTableSize,
        enablePush: options.settings.enablePush !== false,
        initialWindowSize: options.settings.initialWindowSize || 65535,
        maxFrameSize: options.settings.maxFrameSize || 16384,
        maxConcurrentStreams: options.settings.maxConcurrentStreams || 100,
        maxHeaderListSize: options.settings.maxHeaderListSize,
        maxHeaderSize: options.settings.maxHeaderSize,
        enableConnectProtocol: options.settings.enableConnectProtocol,
      };
    } else {
      serverOptions.settings = {
        enablePush: true,
        initialWindowSize: 65535,
        maxFrameSize: 16384,
        maxConcurrentStreams: 100,
      };
    }

    // Create server
    if (this.isSecure) {
      this.server = createHttp2SecureServer(serverOptions);
      this.logger.info('HTTP/2 secure server created', 'ServerInit');
    } else {
      this.server = createHttp2Server(serverOptions);
      this.logger.info('HTTP/2 server created', 'ServerInit');
    }

    // Configure server settings
    this.server.setTimeout(30000);

    // Handle streams (HTTP/2 requests)
    this.server.on('stream', this.handleStream.bind(this));

    // Handle session events
    this.server.on('session', session => {
      this.logger.debug('HTTP/2 session created', 'Session');

      session.on('error', err => {
        this.logger.error('HTTP/2 session error', 'Session', { error: err.message });
      });
    });

    // Handle server errors
    this.server.on('error', err => {
      this.logger.error('HTTP/2 server error', 'ServerError', { error: err.message });
    });
  }

  // Configure server for maximum performance
  configurePerformance(
    config: { compression?: { enabled: boolean; threshold?: number }; minimal?: boolean } = {}
  ) {
    if (config.compression !== undefined) {
      this.compressionEnabled = config.compression.enabled;
      if (config.compression.threshold !== undefined) {
        this.compressionThreshold = config.compression.threshold;
      }
    }

    if (config.minimal) {
      this.compressionEnabled = false;
      this.compressionThreshold = Infinity;
    }
  }

  // Configure request tracking
  setRequestTracking(enabled: boolean): void {
    this.requestTrackingEnabled = enabled;
  }

  // Middleware management
  use(middleware: Middleware): void {
    this.globalMiddleware.push(middleware);
  }

  // Set hooks manager
  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  // Routing methods
  get(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('GET', path, handlers);
  }

  post(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('POST', path, handlers);
  }

  put(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('PUT', path, handlers);
  }

  delete(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('DELETE', path, handlers);
  }

  patch(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('PATCH', path, handlers);
  }

  private addRoute(method: string, path: string, handlers: (Middleware | HttpHandler)[]): void {
    const { pattern, paramNames } = this.pathToRegex(path);
    const handler = handlers.pop() as HttpHandler;
    const middleware = handlers as Middleware[];

    const route = {
      method,
      path,
      pattern,
      paramNames,
      handler,
      middleware,
    };

    this.routes.push(route);

    // Organize routes for optimal lookup
    if (paramNames.length === 0) {
      const staticKey = `${method}:${path}`;
      this.staticRoutes.set(staticKey, route);
    } else {
      this.dynamicRoutes.push(route);
      const segmentCount = PathMatcher.countSegments(path);
      if (!this.routesBySegmentCount.has(segmentCount)) {
        this.routesBySegmentCount.set(segmentCount, []);
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.routesBySegmentCount.get(segmentCount)!.push(route);
    }
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const compiled = PathMatcher.compile(path);
    return {
      pattern: compiled.pattern || new RegExp(`^${path.replace(/\//g, '\\/')}$`),
      paramNames: compiled.paramNames,
    };
  }

  private async handleStream(
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders
  ): Promise<void> {
    this.requestCounter++;

    const httpReq = this.createRequestFromStream(stream, headers);
    const httpRes = this.createResponseFromStream(stream, httpReq);

    try {
      // Parse URL and query
      const url = (headers[':path'] as string) || '/';
      const queryIndex = url.indexOf('?');

      if (queryIndex === -1) {
        httpReq.path = url;
        httpReq.query = {};
      } else {
        httpReq.path = url.substring(0, queryIndex);
        httpReq.query = this.parseQueryString(url.substring(queryIndex + 1));
      }

      // Parse body for POST/PUT/PATCH
      const method = httpReq.method;
      if (
        method === MoroHttp2Server.METHOD_POST ||
        method === MoroHttp2Server.METHOD_PUT ||
        method === MoroHttp2Server.METHOD_PATCH
      ) {
        httpReq.body = await this.parseBody(stream, headers);
      }

      // Execute hooks
      if (this.hookManager) {
        await this.hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // Execute global middleware
      if (this.globalMiddleware.length > 0) {
        await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
      }

      // If middleware handled the request, don't continue
      if (httpRes.headersSent) {
        return;
      }

      // Find matching route (path is always set after URL parsing)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const route = this.findRoute(method || MoroHttp2Server.METHOD_GET, httpReq.path!);
      if (!route) {
        httpRes.statusCode = 404;
        httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
        httpRes.setHeader('Content-Length', MoroHttp2Server.RESPONSE_TEMPLATES.notFound.length);
        httpRes.end(MoroHttp2Server.RESPONSE_TEMPLATES.notFound);
        return;
      }

      // Extract path parameters
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const matches = httpReq.path!.match(route.pattern);
      if (matches) {
        httpReq.params = this.poolManager.acquireParams();
        const paramNames = route.paramNames;
        for (let i = 0; i < paramNames.length; i++) {
          httpReq.params[paramNames[i]] = matches[i + 1];
        }
      }

      // Execute route middleware
      if (route.middleware.length > 0) {
        await this.executeMiddleware(route.middleware, httpReq, httpRes);
      }

      // Execute handler
      const handlerResult = route.handler(httpReq, httpRes);
      if (handlerResult && typeof handlerResult.then === 'function') {
        await handlerResult;
      }
    } catch (error) {
      this.logger.error('HTTP/2 stream error', 'StreamError', {
        error: error instanceof Error ? error.message : String(error),
        requestId: httpReq.requestId,
        path: httpReq.path,
      });

      if (!httpRes.headersSent) {
        httpRes.status(500).json({
          success: false,
          error: 'Internal server error',
          requestId: httpReq.requestId,
        });
      }
    } finally {
      // Release pooled objects
      if (httpReq.params && Object.keys(httpReq.params).length === 0) {
        this.poolManager.releaseParams(httpReq.params);
      }
      if (httpReq.query && Object.keys(httpReq.query).length === 0) {
        this.poolManager.releaseQuery(httpReq.query);
      }
    }
  }

  private createRequestFromStream(
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders
  ): HttpRequest {
    // Extract method from pseudo-header
    const methodRaw = ((headers[':method'] as string) || 'GET').toUpperCase();

    // Intern method string for fast comparison
    let method: string;
    switch (methodRaw) {
      case 'POST':
        method = MoroHttp2Server.METHOD_POST;
        break;
      case 'PUT':
        method = MoroHttp2Server.METHOD_PUT;
        break;
      case 'PATCH':
        method = MoroHttp2Server.METHOD_PATCH;
        break;
      case 'GET':
        method = MoroHttp2Server.METHOD_GET;
        break;
      case 'DELETE':
        method = MoroHttp2Server.METHOD_DELETE;
        break;
      case 'HEAD':
        method = MoroHttp2Server.METHOD_HEAD;
        break;
      case 'OPTIONS':
        method = MoroHttp2Server.METHOD_OPTIONS;
        break;
      default:
        method = methodRaw;
    }

    // Convert HTTP/2 headers to standard headers (remove pseudo-headers)
    const standardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!key.startsWith(':')) {
        standardHeaders[key] = Array.isArray(value) ? value.join(', ') : (value as string);
      }
    }

    // Parse cookies
    const cookieHeader = standardHeaders['cookie'];
    const cookies: Record<string, string> = {};
    if (cookieHeader) {
      const cookieParts = cookieHeader.split(';');
      for (const cookie of cookieParts) {
        const equalIndex = cookie.indexOf('=');
        if (equalIndex > 0) {
          const name = cookie.substring(0, equalIndex).trim();
          const value = cookie.substring(equalIndex + 1);
          if (name && value) {
            cookies[name] = decodeURIComponent(value);
          }
        }
      }
    }

    const httpReq: HttpRequest = {
      method,
      path: '',
      url: (headers[':path'] as string) || '/',
      query: {},
      params: {},
      headers: standardHeaders,
      body: null,
      cookies,
      ip: (stream.session?.socket as any)?.remoteAddress || '',
      requestId: this.requestTrackingEnabled ? this.poolManager.generateRequestId() : '',
      httpVersion: '2.0',
    } as HttpRequest;

    // Store stream reference for push capability
    (httpReq as any)._http2Stream = stream;
    (httpReq as any)._http2Headers = headers;

    return httpReq;
  }

  private createResponseFromStream(stream: ServerHttp2Stream, req: HttpRequest): HttpResponse {
    const httpRes: any = {
      statusCode: 200,
      headersSent: false,
      _headers: {} as OutgoingHttpHeaders,
      _stream: stream,
      _req: req,
      _logger: this.logger,
      _poolManager: this.poolManager,
      _compressionEnabled: this.compressionEnabled,
      _compressionThreshold: this.compressionThreshold,
    };

    // Status method
    httpRes.status = (code: number) => {
      httpRes.statusCode = code;
      return httpRes;
    };

    // Set header
    httpRes.setHeader = (name: string, value: string | string[]) => {
      httpRes._headers[name.toLowerCase()] = value;
      return httpRes;
    };

    // Get header
    httpRes.getHeader = (name: string) => {
      return httpRes._headers[name.toLowerCase()];
    };

    // Remove header
    httpRes.removeHeader = (name: string) => {
      delete httpRes._headers[name.toLowerCase()];
      return httpRes;
    };

    // Has header
    httpRes.hasHeader = (name: string): boolean => {
      return httpRes._headers[name.toLowerCase()] !== undefined;
    };

    // Get headers
    httpRes.getHeaders = () => {
      return { ...httpRes._headers };
    };

    // JSON response
    httpRes.json = async (data: any) => {
      if (httpRes.headersSent || stream.destroyed) return;

      const jsonString = JSON.stringify(data);
      const finalBuffer = Buffer.from(jsonString, 'utf8');

      httpRes._headers['content-type'] = 'application/json; charset=utf-8';

      // Compression
      if (httpRes._compressionEnabled && finalBuffer.length > httpRes._compressionThreshold) {
        const acceptEncoding = req.headers['accept-encoding'];

        if (acceptEncoding && acceptEncoding.includes('gzip')) {
          const compressed = await gzip(finalBuffer);
          httpRes._headers['content-encoding'] = 'gzip';
          httpRes._headers['content-length'] = compressed.length;

          stream.respond({
            ':status': httpRes.statusCode,
            ...httpRes._headers,
          });
          stream.end(compressed);
          httpRes.headersSent = true;
          return;
        } else if (acceptEncoding && acceptEncoding.includes('deflate')) {
          const compressed = await deflate(finalBuffer);
          httpRes._headers['content-encoding'] = 'deflate';
          httpRes._headers['content-length'] = compressed.length;

          stream.respond({
            ':status': httpRes.statusCode,
            ...httpRes._headers,
          });
          stream.end(compressed);
          httpRes.headersSent = true;
          return;
        }
      }

      httpRes._headers['content-length'] = finalBuffer.length;

      stream.respond({
        ':status': httpRes.statusCode,
        ...httpRes._headers,
      });
      stream.end(finalBuffer);
      httpRes.headersSent = true;
    };

    // Send response
    httpRes.send = (data: string | Buffer) => {
      if (httpRes.headersSent || stream.destroyed) return;

      if (!httpRes._headers['content-type']) {
        if (typeof data === 'string') {
          try {
            JSON.parse(data);
            httpRes._headers['content-type'] = 'application/json; charset=utf-8';
          } catch {
            httpRes._headers['content-type'] = 'text/plain; charset=utf-8';
          }
        } else {
          httpRes._headers['content-type'] = 'application/octet-stream';
        }
      }

      const buffer = typeof data === 'string' ? Buffer.from(data) : data;
      httpRes._headers['content-length'] = buffer.length;

      stream.respond({
        ':status': httpRes.statusCode,
        ...httpRes._headers,
      });
      stream.end(buffer);
      httpRes.headersSent = true;
    };

    // End response
    httpRes.end = (data?: any) => {
      if (httpRes.headersSent || stream.destroyed) return httpRes;

      stream.respond({
        ':status': httpRes.statusCode,
        ...httpRes._headers,
      });
      stream.end(data || '');
      httpRes.headersSent = true;
      return httpRes;
    };

    // Standardized response helpers
    httpRes.success = <T = any>(data: T, message?: string) => {
      const response: any = {
        success: true,
        data,
      };
      if (message !== undefined) {
        response.message = message;
      }
      httpRes.json(response);
    };

    httpRes.error = (error: string, code?: string, message?: string) => {
      const response: any = {
        success: false,
        error,
      };
      if (code !== undefined) {
        response.code = code;
      }
      if (message !== undefined) {
        response.message = message;
      }
      httpRes.json(response);
    };

    // Common HTTP error helpers (automatically set status code)
    httpRes.unauthorized = (message: string = 'Authentication required') => {
      httpRes.statusCode = 401;
      httpRes.json({
        success: false,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message,
      });
    };

    httpRes.forbidden = (message: string = 'Insufficient permissions') => {
      httpRes.statusCode = 403;
      httpRes.json({
        success: false,
        error: 'Forbidden',
        code: 'FORBIDDEN',
        message,
      });
    };

    httpRes.notFound = (resource: string = 'Resource') => {
      httpRes.statusCode = 404;
      httpRes.json({
        success: false,
        error: 'Not Found',
        code: 'NOT_FOUND',
        message: `${resource} not found`,
      });
    };

    httpRes.badRequest = (message: string = 'Invalid request') => {
      httpRes.statusCode = 400;
      httpRes.json({
        success: false,
        error: 'Bad Request',
        code: 'BAD_REQUEST',
        message,
      });
    };

    httpRes.conflict = (message: string) => {
      httpRes.statusCode = 409;
      httpRes.json({
        success: false,
        error: 'Conflict',
        code: 'CONFLICT',
        message,
      });
    };

    httpRes.internalError = (message: string = 'Internal server error') => {
      httpRes.statusCode = 500;
      httpRes.json({
        success: false,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message,
      });
    };

    httpRes.validationError = (
      errors: Array<{ field: string; message: string; code?: string }>
    ) => {
      httpRes.statusCode = 422;
      httpRes.json({
        success: false,
        error: 'Validation Failed',
        code: 'VALIDATION_ERROR',
        errors,
      });
    };

    httpRes.rateLimited = (retryAfter?: number) => {
      httpRes.statusCode = 429;
      if (retryAfter) {
        httpRes.setHeader('Retry-After', retryAfter.toString());
      }
      httpRes.json({
        success: false,
        error: 'Rate Limit Exceeded',
        code: 'RATE_LIMITED',
        message: retryAfter
          ? `Too many requests. Retry after ${retryAfter} seconds.`
          : 'Too many requests',
        retryAfter,
      });
    };

    // Common success patterns
    httpRes.created = <T = any>(data: T, location?: string) => {
      httpRes.statusCode = 201;
      if (location) {
        httpRes.setHeader('Location', location);
      }
      httpRes.json({
        success: true,
        data,
      });
    };

    httpRes.noContent = () => {
      httpRes.statusCode = 204;
      httpRes.end();
    };

    httpRes.paginated = <T = any>(
      data: T[],
      pagination: { page: number; limit: number; total: number }
    ) => {
      const totalPages = Math.ceil(pagination.total / pagination.limit);
      httpRes.json({
        success: true,
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total: pagination.total,
          totalPages,
          hasNext: pagination.page < totalPages,
          hasPrev: pagination.page > 1,
        },
      });
    };

    // Cookie handling
    httpRes.cookie = (name: string, value: string, options: any = {}) => {
      if (httpRes.headersSent) {
        const isCritical = options.critical || name.includes('session') || name.includes('auth');
        const message = `Cookie '${name}' could not be set - headers already sent`;

        if (isCritical || options.throwOnLateSet) {
          throw new Error(`${message}. This may cause authentication or security issues.`);
        } else {
          httpRes._logger.warn(message, 'CookieWarning', { cookieName: name });
        }
        return httpRes;
      }

      const cookieValue = encodeURIComponent(value);
      let cookieString = `${name}=${cookieValue}`;

      if (options.maxAge) cookieString += `; Max-Age=${options.maxAge}`;
      if (options.expires) cookieString += `; Expires=${options.expires.toUTCString()}`;
      if (options.httpOnly) cookieString += '; HttpOnly';
      if (options.secure) cookieString += '; Secure';
      if (options.sameSite) cookieString += `; SameSite=${options.sameSite}`;
      if (options.domain) cookieString += `; Domain=${options.domain}`;
      if (options.path) cookieString += `; Path=${options.path}`;

      const existingCookies = httpRes._headers['set-cookie'] || [];
      const cookies = Array.isArray(existingCookies)
        ? existingCookies
        : [existingCookies as string];
      cookies.push(cookieString);
      httpRes._headers['set-cookie'] = cookies;

      return httpRes;
    };

    // Clear cookie
    httpRes.clearCookie = (name: string, options: any = {}) => {
      return httpRes.cookie(name, '', {
        expires: new Date(0),
        maxAge: 0,
        ...options,
      });
    };

    // Redirect
    httpRes.redirect = (url: string, status: number = 302) => {
      if (httpRes.headersSent || stream.destroyed) return;

      httpRes.statusCode = status;
      httpRes._headers['location'] = url;

      stream.respond({
        ':status': status,
        ...httpRes._headers,
      });
      stream.end();
      httpRes.headersSent = true;
    };

    // HTTP/2 Server Push
    httpRes.push = (
      path: string,
      options: { headers?: OutgoingHttpHeaders; priority?: number } = {}
    ) => {
      if (httpRes.headersSent || stream.destroyed || !stream.pushAllowed) {
        return null;
      }

      try {
        const pushHeaders: any = {
          ':path': path,
          ':method': 'GET',
          ...options.headers,
        };

        const pushStream = stream.pushStream(pushHeaders, err => {
          if (err) {
            httpRes._logger.debug('Server push failed', 'ServerPush', {
              path,
              error: err.message,
            });
          }
        });

        // Set stream priority if specified
        if (options.priority !== undefined && pushStream) {
          try {
            // Priority weight: 1-256 (default 16)
            // Higher values = higher priority
            const weight = Math.max(1, Math.min(256, options.priority));
            (pushStream as any).priority({
              parent: 0,
              weight,
              exclusive: false,
            });
          } catch (error) {
            httpRes._logger.debug('Failed to set stream priority', 'StreamPriority', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return pushStream;
      } catch (error) {
        httpRes._logger.debug('Server push error', 'ServerPush', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    // Set stream priority for current response
    httpRes.setPriority = (
      options: { parent?: number; weight?: number; exclusive?: boolean } = {}
    ) => {
      if (httpRes.headersSent || stream.destroyed) {
        return httpRes;
      }

      try {
        stream.priority({
          parent: options.parent || 0,
          weight: options.weight ? Math.max(1, Math.min(256, options.weight)) : 16,
          exclusive: options.exclusive || false,
        });
      } catch (error) {
        httpRes._logger.debug('Failed to set stream priority', 'StreamPriority', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return httpRes;
    };

    // Set bulk headers
    httpRes.setBulkHeaders = (headers: Record<string, string | number>) => {
      if (httpRes.headersSent) {
        httpRes._logger.warn('Cannot set headers - headers already sent', 'HeaderWarning');
        return httpRes;
      }

      for (const key in headers) {
        httpRes._headers[key.toLowerCase()] = String(headers[key]);
      }
      return httpRes;
    };

    // Response state
    httpRes.canSetHeaders = (): boolean => {
      return !httpRes.headersSent;
    };

    httpRes.getResponseState = () => {
      return {
        headersSent: httpRes.headersSent,
        statusCode: httpRes.statusCode,
        headers: httpRes.getHeaders(),
        finished: stream.destroyed,
        writable: !stream.destroyed,
      };
    };

    return httpRes as HttpResponse;
  }

  private async parseBody(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<any> {
    const contentType = (headers['content-type'] as string) || '';
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const contentLength = parseInt((headers['content-length'] as string) || '0');
    const maxSize = 10 * 1024 * 1024; // 10MB limit

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLength = 0;

      stream.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        try {
          const body = Buffer.concat(chunks);

          if (contentType.includes('application/json')) {
            resolve(JSON.parse(body.toString()));
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            resolve(this.parseUrlEncoded(body.toString()));
          } else {
            resolve(body.toString());
          }
        } catch (error) {
          reject(error);
        }
      });

      stream.on('error', reject);
    });
  }

  private parseUrlEncoded(body: string): Record<string, string> {
    const params = new URLSearchParams(body);
    const result: Record<string, string> = {};
    for (const [key, value] of params) {
      result[key] = value;
    }
    return result;
  }

  private parseQueryString(queryString: string): Record<string, string> {
    if (!queryString) return {};

    const result = this.poolManager.acquireQuery();
    const pairs = queryString.split('&');

    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=');
      if (equalIndex === -1) {
        result[decodeURIComponent(pair)] = '';
      } else {
        const key = decodeURIComponent(pair.substring(0, equalIndex));
        const value = decodeURIComponent(pair.substring(equalIndex + 1));
        result[key] = value;
      }
    }
    return result;
  }

  private normalizePath(path: string): string {
    if (this.pathNormalizationCache.has(path)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.pathNormalizationCache.get(path)!;
    }

    let normalized = path;
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    if (this.pathNormalizationCache.size < 200) {
      this.pathNormalizationCache.set(path, normalized);
    }

    return normalized;
  }

  private findRoute(method: string, path: string | undefined): RouteEntry | null {
    // Default to '/' if path is undefined
    const searchPath = path || '/';
    const cacheKey = `${method}:${searchPath}`;

    if (this.routeCache.has(cacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(cacheKey)!;
    }

    const normalizedPath = this.normalizePath(searchPath);
    const normalizedCacheKey =
      normalizedPath !== searchPath ? `${method}:${normalizedPath}` : cacheKey;

    if (normalizedPath !== path && this.routeCache.has(normalizedCacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(normalizedCacheKey)!;
    }

    const staticRoute = this.staticRoutes.get(normalizedCacheKey);
    if (staticRoute) {
      this.routeCache.set(normalizedCacheKey, staticRoute);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, staticRoute);
      }
      return staticRoute;
    }

    let route: RouteEntry | null = null;
    if (this.dynamicRoutes.length > 0) {
      const segmentCount = PathMatcher.countSegments(normalizedPath);
      const candidateRoutes = this.routesBySegmentCount.get(segmentCount) || this.dynamicRoutes;

      for (const candidateRoute of candidateRoutes) {
        if (candidateRoute.method === method && candidateRoute.pattern.test(normalizedPath)) {
          route = candidateRoute;
          break;
        }
      }
    }

    if (this.routeCache.size < 500) {
      this.routeCache.set(normalizedCacheKey, route);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, route);
      }
    }

    return route;
  }

  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    for (const mw of middleware) {
      if (res.headersSent) return;

      await new Promise<void>((resolve, reject) => {
        let resolved = false;

        const next = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };

        try {
          const result = mw(req, res, next);

          if (result && typeof result.then === 'function') {
            (result as Promise<void>)
              .then(() => {
                if (!resolved) next();
              })
              .catch(reject);
          } else if (!resolved) {
            next();
          }
        } catch (error) {
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        }
      });
    }
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, host?: string | (() => void), callback?: () => void): void {
    if (typeof host === 'function') {
      callback = host;
      host = undefined;
    }

    if (host) {
      this.server.listen(port, host, callback);
    } else {
      this.server.listen(port, callback);
    }
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => resolve());
    });
  }

  forceCleanup(): void {
    this.poolManager.clearAll();
    if (globalThis?.gc) {
      globalThis.gc();
    }
  }

  getServer(): Http2Server | Http2SecureServer {
    return this.server;
  }

  getPerformanceStats() {
    const poolStats = this.poolManager.getStats();
    return {
      paramObjectPoolSize: poolStats.paramPool.poolSize,
      queryObjectPoolSize: poolStats.queryPool.poolSize,
      headerObjectPoolSize: poolStats.headerPool.poolSize,
      poolManager: poolStats,
    };
  }
}
