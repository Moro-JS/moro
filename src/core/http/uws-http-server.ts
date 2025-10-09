// uWebSockets.js HTTP Server Implementation for Moro Framework
// Provides ultra-high-performance HTTP and WebSocket server using uWebSockets.js

import cluster from 'cluster';
import { createFrameworkLogger } from '../logger/index.js';
import {
  HttpRequest,
  HttpResponse,
  HttpHandler,
  Middleware,
  RouteEntry,
} from '../../types/http.js';

/**
 * uWebSockets HTTP Server Adapter
 * Bridges uWebSockets.js with Moro's HTTP abstractions
 */
export class UWebSocketsHttpServer {
  private app: any; // uWebSockets app instance
  private uws: any; // uWebSockets module reference (stored to avoid re-importing)
  private listenSocket: any; // uWebSockets listen socket
  private routes: RouteEntry[] = [];
  private globalMiddleware: Middleware[] = [];
  private logger = createFrameworkLogger('UWSHttpServer');
  private hookManager: any;
  private requestCounter = 0;
  private isListening = false;
  private port?: number;
  private host?: string;
  private initPromise: Promise<void>;

  // Route caching for performance
  private staticRoutes = new Map<string, RouteEntry>();
  private dynamicRoutes: RouteEntry[] = [];

  // Performance optimizations - object pooling
  private paramObjectPool: Record<string, string>[] = [];
  private queryObjectPool: Record<string, string>[] = [];
  private readonly maxPoolSize = 100;

  // String interning for common values
  private static readonly INTERNED_METHODS = new Map([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['delete', 'DELETE'],
    ['patch', 'PATCH'],
    ['head', 'HEAD'],
    ['options', 'OPTIONS'],
  ]);

  // Pre-compiled response buffers
  private static readonly RESPONSE_BUFFERS = {
    notFound: Buffer.from('{"success":false,"error":"Not found"}'),
    serverError: Buffer.from('{"success":false,"error":"Internal server error"}'),
  };

  constructor(
    options: {
      ssl?: { key_file_name?: string; cert_file_name?: string; passphrase?: string };
    } = {}
  ) {
    this.initPromise = this.initialize(options);
  }

  private async initialize(options: {
    ssl?: { key_file_name?: string; cert_file_name?: string; passphrase?: string };
  }): Promise<void> {
    try {
      // Lazy load uWebSockets.js - only when explicitly configured
      // This ensures it's an optional dependency with graceful fallback
      const uwsModule = await import('uWebSockets.js');
      this.uws = uwsModule.default || uwsModule;

      if (options.ssl && options.ssl.key_file_name && options.ssl.cert_file_name) {
        this.app = this.uws.SSLApp({
          key_file_name: options.ssl.key_file_name,
          cert_file_name: options.ssl.cert_file_name,
          passphrase: options.ssl.passphrase,
        });
        this.logger.info('uWebSockets SSL/TLS HTTP server created', 'Init');
      } else {
        this.app = this.uws.App();
        this.logger.info('uWebSockets HTTP server created', 'Init');
      }

      // Setup generic route handler for all HTTP methods and paths
      this.setupRouteHandlers();
    } catch (error) {
      // Log helpful error message with installation instructions
      this.logger.error(
        'Failed to load uWebSockets.js (optional dependency)\n' +
          'To use uWebSockets, install it with:\n' +
          '  npm install --save-dev github:uNetworking/uWebSockets.js#v20.52.0\n' +
          'Or set useUWebSockets: false in your config to use the standard HTTP server.\n' +
          'Error: ' +
          (error instanceof Error ? error.message : String(error)),
        'Init'
      );
      throw error; // Re-throw so framework.ts can catch and fallback
    }
  }

  private setupRouteHandlers(): void {
    // Handle all HTTP methods through catchall for proper routing
    this.app.any('/*', (res: any, req: any) => {
      // Try fast synchronous path first
      const method = req.getMethod().toUpperCase();
      const path = req.getUrl();

      // Fast path: No body, no global middleware
      if (this.globalMiddleware.length === 0 && method === 'GET') {
        const route = this.findRoute(method, path);
        if (route && (!route.middleware || route.middleware.length === 0)) {
          this.handleRequestSync(req, res, route, method, path);
          return;
        }
      }

      // Slow path: Has middleware or body or other complexity
      this.handleRequest(req, res);
    });
  }

  // Fast synchronous handler for simple GET requests
  private handleRequestSync(
    req: any,
    res: any,
    route: RouteEntry,
    method: string,
    path: string
  ): void {
    this.requestCounter++;
    let httpReq: any;

    try {
      httpReq = this.createMoroRequest(req, res);
      const httpRes = this.createMoroResponse(req, res);

      // Extract params if needed
      if (route.paramNames.length > 0) {
        const matches = path.match(route.pattern);
        if (matches) {
          httpReq.params = this.acquireParamObject();
          route.paramNames.forEach((name: string, index: number) => {
            httpReq.params![name] = matches[index + 1];
          });
          (httpReq as any)._pooledParams = httpReq.params;
        }
      }

      // Execute handler synchronously
      const result = route.handler(httpReq, httpRes);

      // Handle return value
      if (result && typeof result.then === 'function') {
        // Oops, handler is async - handle it
        result
          .then((data: any) => {
            if (data !== undefined && data !== null && !httpRes.headersSent) {
              httpRes.json(data);
            }
          })
          .catch(() => {
            if (!res.aborted) {
              res.cork(() => {
                res.writeStatus('500 Internal Server Error');
                res.end('{"success":false,"error":"Internal server error"}');
              });
            }
          });
      } else if (result !== undefined && result !== null && !httpRes.headersSent) {
        httpRes.json(result);
      }
    } finally {
      const pooledParams = (httpReq as any)?._pooledParams;
      if (pooledParams) this.releaseParamObject(pooledParams);

      const pooledQuery = (httpReq as any)?._pooledQuery;
      if (pooledQuery) this.releaseQueryObject(pooledQuery);
    }
  }

  // Object pooling methods for performance
  private acquireParamObject(): Record<string, string> {
    return this.paramObjectPool.pop() || {};
  }

  private releaseParamObject(obj: Record<string, string>): void {
    if (this.paramObjectPool.length < this.maxPoolSize) {
      for (const key in obj) delete obj[key];
      this.paramObjectPool.push(obj);
    }
  }

  private acquireQueryObject(): Record<string, string> {
    return this.queryObjectPool.pop() || {};
  }

  private releaseQueryObject(obj: Record<string, string>): void {
    if (this.queryObjectPool.length < this.maxPoolSize) {
      for (const key in obj) delete obj[key];
      this.queryObjectPool.push(obj);
    }
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    this.requestCounter++;

    // Declare outside try block for cleanup in finally
    let httpReq: any;

    try {
      // Create Moro-compatible request object
      httpReq = this.createMoroRequest(req, res);
      const httpRes = this.createMoroResponse(req, res);

      // Parse body only if there's actually a body (check content-length)
      const method = req.getMethod().toUpperCase();
      const contentLength = req.getHeader('content-length');
      if (
        (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
        contentLength &&
        parseInt(contentLength) > 0
      ) {
        await this.readBody(res, httpReq);
      }

      // Execute hooks before request processing
      if (this.hookManager) {
        await this.hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // Find route first (before middleware)
      const route = this.findRoute(httpReq.method!, httpReq.path);

      if (!route) {
        // 404 Not Found - fast path
        if (!httpRes.headersSent) {
          httpRes.statusCode = 404;
          httpRes.setHeader('Content-Type', 'application/json');
          httpRes.end('{"success":false,"error":"Not found"}');
        }
        return;
      }

      // Extract path parameters early - use pooled object
      const matches = httpReq.path.match(route.pattern);
      if (matches) {
        httpReq.params = this.acquireParamObject();
        route.paramNames.forEach((name: string, index: number) => {
          httpReq.params![name] = matches[index + 1];
        });
        // Store for cleanup
        (httpReq as any)._pooledParams = httpReq.params;
      }

      // Execute ALL middleware in one pass (global + route)
      if (this.globalMiddleware.length > 0 || (route.middleware && route.middleware.length > 0)) {
        const allMiddleware =
          route.middleware && route.middleware.length > 0
            ? [...this.globalMiddleware, ...route.middleware]
            : this.globalMiddleware;

        await this.executeMiddleware(allMiddleware, httpReq, httpRes);
        if (httpRes.headersSent) return;
      }

      // Execute route handler
      const result = await route.handler(httpReq, httpRes);

      // If handler returns data and response hasn't been sent, send it
      if (result !== undefined && result !== null && !httpRes.headersSent) {
        httpRes.json(result);
      }
    } catch (error) {
      this.logger.error(
        `Request handling error: ${error instanceof Error ? error.message : String(error)}`,
        'RequestError'
      );

      // Send error response if not already sent
      if (!res.aborted) {
        try {
          res.cork(() => {
            res.writeStatus('500 Internal Server Error');
            res.writeHeader('Content-Type', 'application/json');
            res.end('{"success":false,"error":"Internal server error"}');
          });
        } catch (writeError) {
          this.logger.error('Failed to send error response', 'ResponseError');
        }
      }
    } finally {
      // Cleanup: Release pooled objects back to pool for reuse
      const pooledParams = (httpReq as any)._pooledParams;
      if (pooledParams) {
        this.releaseParamObject(pooledParams);
      }

      const pooledQuery = (httpReq as any)._pooledQuery;
      if (pooledQuery) {
        this.releaseQueryObject(pooledQuery);
      }
    }
  }

  private createMoroRequest(req: any, res: any): HttpRequest {
    const url = req.getUrl();
    const queryString = req.getQuery();
    const methodRaw = req.getMethod();

    // Use interned method string if available
    const method = UWebSocketsHttpServer.INTERNED_METHODS.get(methodRaw) || methodRaw.toUpperCase();

    // Lazy query parsing - use pooled object
    let queryParams: Record<string, string> | undefined;
    if (queryString) {
      queryParams = this.acquireQueryObject();
      // Fast query parsing without URLSearchParams overhead
      const pairs = queryString.split('&');
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const key = pair.substring(0, eqIdx);
          const value = pair.substring(eqIdx + 1);
          queryParams[decodeURIComponent(key)] = decodeURIComponent(value);
        }
      }
    }

    // Lazy header parsing - only parse headers that exist
    const headers: Record<string, string> = {};
    req.forEach((key: string, value: string) => {
      const lowerKey = key.toLowerCase();
      headers[lowerKey] = value;
    });

    const httpReq = {
      method,
      path: url,
      url: url,
      query: queryParams || {},
      params: {}, // Will be filled by route matching
      headers,
      body: null,
      ip: '', // Lazy - only compute if accessed
      requestId: '', // Lazy - only generate if accessed
    } as HttpRequest;

    // Store original query object for cleanup
    (httpReq as any)._pooledQuery = queryParams;

    return httpReq;
  }

  private createMoroResponse(req: any, res: any): HttpResponse {
    let headersSent = false;
    let statusCode = 200;
    const responseHeaders: Record<string, string | string[]> = {};
    //eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const httpRes = {
      statusCode,
      get headersSent() {
        return headersSent;
      },

      status(code: number) {
        statusCode = code;
        (httpRes as any).statusCode = code;
        return httpRes as HttpResponse;
      },

      setHeader(name: string, value: string | string[]) {
        responseHeaders[name.toLowerCase()] = value;
        return httpRes as HttpResponse;
      },

      getHeader(name: string) {
        return responseHeaders[name.toLowerCase()];
      },

      removeHeader(name: string) {
        delete responseHeaders[name.toLowerCase()];
        return httpRes as HttpResponse;
      },

      json(data: any) {
        if (headersSent || res.aborted) return;

        const body = JSON.stringify(data);
        responseHeaders['content-type'] = 'application/json';

        try {
          res.cork(() => {
            res.writeStatus(`${statusCode} OK`);
            Object.entries(responseHeaders).forEach(([key, value]) => {
              res.writeHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
            });
            res.end(body);
          });
          headersSent = true;
        } catch (error) {
          self.logger.error('Failed to send JSON response', 'ResponseError');
        }
      },

      send(data: string | Buffer) {
        if (headersSent || res.aborted) return;

        const body = typeof data === 'string' ? data : data.toString();

        try {
          res.cork(() => {
            res.writeStatus(`${statusCode} OK`);
            Object.entries(responseHeaders).forEach(([key, value]) => {
              res.writeHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
            });
            res.end(body);
          });
          headersSent = true;
        } catch (error) {
          self.logger.error('Failed to send response', 'ResponseError');
        }
      },

      end(data?: any, encoding?: any, callback?: any) {
        if (headersSent || res.aborted) {
          if (typeof callback === 'function') callback();
          return httpRes as HttpResponse;
        }

        try {
          res.cork(() => {
            res.writeStatus(`${statusCode} OK`);
            Object.entries(responseHeaders).forEach(([key, value]) => {
              res.writeHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
            });
            res.end(data || '');
          });
          headersSent = true;
          if (typeof callback === 'function') callback();
        } catch (error) {
          self.logger.error('Failed to end response', 'ResponseError');
          if (typeof callback === 'function') callback();
        }

        return httpRes as HttpResponse;
      },

      redirect(url: string, code?: number) {
        if (headersSent || res.aborted) return;

        const redirectCode = code || 302;
        statusCode = redirectCode;

        try {
          res.cork(() => {
            res.writeStatus(`${redirectCode} Found`);
            res.writeHeader('Location', url);
            res.end();
          });
          headersSent = true;
        } catch (error) {
          self.logger.error('Failed to send redirect', 'ResponseError');
        }
      },

      // EventEmitter compatibility - stub implementations for middleware
      on(event: string, callback: Function) {
        // uWebSockets doesn't use events like Node.js, but middleware might try to listen
        // Only implement 'finish' and 'close' events as stubs
        return httpRes;
      },

      once(event: string, callback: Function) {
        return httpRes;
      },

      emit(event: string, ...args: any[]) {
        return true;
      },

      removeListener(event: string, callback: Function) {
        return httpRes;
      },

      cookie(name: string, value: string, options?: any) {
        let cookie = `${name}=${value}`;

        if (options) {
          if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`;
          if (options.domain) cookie += `; Domain=${options.domain}`;
          if (options.path) cookie += `; Path=${options.path}`;
          if (options.secure) cookie += '; Secure';
          if (options.httpOnly) cookie += '; HttpOnly';
          if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
        }

        const existing = responseHeaders['set-cookie'];
        if (existing) {
          if (Array.isArray(existing)) {
            responseHeaders['set-cookie'] = [...existing, cookie];
          } else {
            responseHeaders['set-cookie'] = [existing as string, cookie];
          }
        } else {
          responseHeaders['set-cookie'] = cookie;
        }

        return httpRes as HttpResponse;
      },
    } as any;

    return httpRes as HttpResponse;
  }

  private async readBody(res: any, httpReq: HttpRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer: Buffer;

      res.onData((chunk: ArrayBuffer, isLast: boolean) => {
        const chunkBuffer = Buffer.from(chunk);

        if (isLast) {
          if (buffer) {
            buffer = Buffer.concat([buffer, chunkBuffer]);
          } else {
            buffer = chunkBuffer;
          }

          try {
            const contentType = httpReq.headers['content-type'] || '';

            if (contentType.includes('application/json')) {
              httpReq.body = JSON.parse(buffer.toString('utf-8'));
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
              const params = new URLSearchParams(buffer.toString('utf-8'));
              const body: Record<string, any> = {};
              params.forEach((value, key) => {
                body[key] = value;
              });
              httpReq.body = body;
            } else {
              httpReq.body = buffer.toString('utf-8');
            }

            resolve();
          } catch (error) {
            this.logger.error('Failed to parse request body', 'BodyParseError');
            httpReq.body = null;
            resolve();
          }
        } else {
          if (buffer) {
            buffer = Buffer.concat([buffer, chunkBuffer]);
          } else {
            buffer = chunkBuffer;
          }
        }
      });

      res.onAborted(() => {
        this.logger.debug('Request aborted', 'RequestAborted');
        resolve();
      });
    });
  }

  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    for (const mw of middleware) {
      if (res.headersSent) break;

      await new Promise<void>((resolve, reject) => {
        try {
          const result = mw(req, res, (err?: Error) => {
            if (err) reject(err);
            else resolve();
          });

          // Handle async middleware
          if (result && typeof result.then === 'function') {
            result.then(() => resolve()).catch(reject);
          }
        } catch (error) {
          reject(error);
        }
      });
    }
  }

  private findRoute(method: string, path: string): RouteEntry | null {
    // Fast path: static route lookup
    const staticKey = `${method}:${path}`;
    const staticRoute = this.staticRoutes.get(staticKey);
    if (staticRoute) return staticRoute;

    // Dynamic route matching
    for (const route of this.dynamicRoutes) {
      if (route.method === method && route.pattern.test(path)) {
        return route;
      }
    }

    return null;
  }

  // Public API - matches MoroHttpServer interface

  use(middleware: Middleware): void {
    this.globalMiddleware.push(middleware);
  }

  get(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('GET', path, handler, middleware);
  }

  post(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('POST', path, handler, middleware);
  }

  put(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('PUT', path, handler, middleware);
  }

  delete(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('DELETE', path, handler, middleware);
  }

  patch(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('PATCH', path, handler, middleware);
  }

  options(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('OPTIONS', path, handler, middleware);
  }

  head(path: string, handler: HttpHandler, middleware?: Middleware[]): void {
    this.addRoute('HEAD', path, handler, middleware);
  }

  private addRoute(
    method: string,
    path: string,
    handler: HttpHandler,
    middleware?: Middleware[]
  ): void {
    const { pattern, paramNames } = this.pathToRegex(path);

    const route: RouteEntry = {
      method,
      path,
      pattern,
      paramNames,
      handler,
      middleware: middleware || [],
    };

    this.routes.push(route);

    // Optimize route lookup
    if (paramNames.length === 0) {
      // Static route
      this.staticRoutes.set(`${method}:${path}`, route);
    } else {
      // Dynamic route
      this.dynamicRoutes.push(route);
    }

    this.logger.debug(`Route registered: ${method} ${path}`, 'RouteRegistration');
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexPath = path.replace(/\//g, '\\/').replace(/:([^/]+)/g, (match, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });

    return {
      pattern: new RegExp(`^${regexPath}$`),
      paramNames,
    };
  }

  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  configurePerformance(config: any): void {
    // uWebSockets is already highly optimized
    // This method exists for API compatibility
    this.logger.debug('Performance configuration noted (uWebSockets is pre-optimized)', 'Config');
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void): void {
    // Wrap in async to await init
    this.initPromise
      .then(() => {
        if (this.isListening) {
          this.logger.warn('Server is already listening', 'Listen');
          return;
        }

        const host = typeof hostOrCallback === 'string' ? hostOrCallback : '0.0.0.0';
        const cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;

        this.port = port;
        this.host = host;

        // Check if we're in a cluster environment
        const isClusterWorker = cluster.isWorker;
        const isClusterPrimary = cluster.isPrimary;

        // ALWAYS use LIBUS_LISTEN_EXCLUSIVE_PORT when clustering
        // This enables SO_REUSEPORT at the OS level, allowing multiple processes to bind to the same port
        // NOTE: uWebSockets.js API doesn't have listen(host, port, options, cb)
        // We must use listen(port, options, cb) which binds to 0.0.0.0
        const listenOptions = 1; // ALWAYS use LIBUS_LISTEN_EXCLUSIVE_PORT for clustering support

        this.app.listen(port, listenOptions, (token: any) => {
          if (token) {
            this.listenSocket = token;
            this.isListening = true;
            const clusterInfo = isClusterWorker ? ` (worker ${process.pid})` : '';
            this.logger.info(
              `uWebSockets HTTP server listening on 0.0.0.0:${port}${clusterInfo}`,
              'Listen'
            );
            if (cb) cb();
          } else {
            const clusterInfo = isClusterWorker ? ` (worker ${process.pid})` : '';
            this.logger.error(`Failed to listen on port ${port}${clusterInfo}`, 'Listen');
            // Don't throw in cluster workers - let them fail gracefully
            if (!isClusterWorker) {
              throw new Error(`Failed to bind to port ${port}`);
            }
          }
        });
      })
      .catch(error => {
        this.logger.error('Failed to initialize server before listen', 'Listen', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async close(callback?: () => void): Promise<void> {
    if (!this.isListening) {
      if (callback) callback();
      return;
    }

    try {
      // Use stored module reference instead of re-importing
      if (this.listenSocket && this.uws) {
        this.uws.us_listen_socket_close(this.listenSocket);
        this.listenSocket = null;
        this.isListening = false;
        this.logger.info('uWebSockets HTTP server closed', 'Close');
      }
      if (callback) callback();
    } catch (error) {
      this.logger.error('Error closing server', 'Close');
      if (callback) callback();
    }
  }

  getServer(): any {
    // Return the uWebSockets app for direct access if needed
    return this.app;
  }

  getApp(): any {
    return this.app;
  }

  forceCleanup(): void {
    // Cleanup method for compatibility
    this.logger.debug('Force cleanup called', 'Cleanup');
  }
}
