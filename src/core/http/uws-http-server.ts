// uWebSockets.js HTTP Server Implementation for Moro Framework
// Provides high-performance HTTP and WebSocket server using uWebSockets.js

import cluster from 'cluster';
import { createFrameworkLogger } from '../logger/index.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';
import { HttpRequest, HttpResponse, Middleware } from '../../types/http.js';

/**
 * uWebSockets HTTP Server Adapter
 * Bridges uWebSockets.js with Moro's HTTP abstractions
 */
export class UWebSocketsHttpServer {
  private app: any; // uWebSockets app instance
  private uws: any; // uWebSockets module reference (stored to avoid re-importing)
  private listenSocket: any; // uWebSockets listen socket
  private globalMiddleware: Middleware[] = [];
  private logger = createFrameworkLogger('UWSHttpServer');
  private hookManager: any;
  private requestCounter = 0;
  private requestTrackingEnabled = true; // Generate request IDs
  private isListening = false;
  private port?: number;
  private host?: string;
  private initPromise: Promise<void>;

  // Performance optimizations - shared object pooling
  private poolManager = ObjectPoolManager.getInstance();

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

  // Pre-cached status strings for common codes (performance optimization)
  private static readonly STATUS_STRINGS = new Map([
    [200, '200 OK'],
    [201, '201 Created'],
    [204, '204 No Content'],
    [301, '301 Moved Permanently'],
    [302, '302 Found'],
    [304, '304 Not Modified'],
    [400, '400 Bad Request'],
    [401, '401 Unauthorized'],
    [403, '403 Forbidden'],
    [404, '404 Not Found'],
    [500, '500 Internal Server Error'],
    [502, '502 Bad Gateway'],
    [503, '503 Service Unavailable'],
  ]);

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
    // Handle all HTTP methods through catchall
    // All requests go through middleware chain (includes UnifiedRouter)
    this.app.any('/*', (res: any, req: any) => {
      this.handleRequest(req, res);
    });
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    this.requestCounter++;

    // Declare outside try block for cleanup in finally
    let httpReq: any;
    let httpRes: any;

    try {
      // Create Moro-compatible request object
      httpReq = this.createMoroRequest(req, res);
      httpRes = this.createMoroResponse(req, res);

      // Parse body only if there's actually a body (check content-length)
      const method = req.getMethod().toUpperCase();
      const contentLength = req.getHeader('content-length');
      // Optimized: Check first char for early exit (all body methods start with 'P')
      const firstChar = method.charCodeAt(0);
      if (
        firstChar === 80 && // 'P' char code
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

      // Execute middleware chain (includes UnifiedRouter for routing)
      // The UnifiedRouter will handle route matching, params extraction, and handler execution
      if (this.globalMiddleware.length > 0) {
        await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
      } else {
        // No middleware - send 404 (router middleware should be present)
        if (!httpRes.headersSent) {
          httpRes.statusCode = 404;
          httpRes.setHeader('Content-Type', 'application/json');
          httpRes.end('{"success":false,"error":"Not found"}');
        }
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
        } catch {
          this.logger.error('Failed to send error response', 'ResponseError');
        }
      }
    } finally {
      // CRITICAL: Release pooled objects back to pool
      if (httpReq) {
        const pooledQuery = (httpReq as any)._pooledQuery;
        const pooledHeaders = (httpReq as any)._pooledHeaders;

        // Only release if object has keys (avoid pool churn for empty objects)
        if (pooledQuery) {
          let hasKeys = false;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const _key in pooledQuery) {
            hasKeys = true;
            break;
          }
          if (hasKeys) {
            this.poolManager.releaseQuery(pooledQuery);
          }
        }

        if (pooledHeaders) {
          let hasKeys = false;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const _key in pooledHeaders) {
            hasKeys = true;
            break;
          }
          if (hasKeys) {
            this.poolManager.releaseHeaders(pooledHeaders);
          }
        }
      }

      if (httpRes) {
        this.releaseResponse(httpRes);
      }
    }
  }

  private createMoroRequest(req: any, _res: any): HttpRequest {
    const url = req.getUrl();
    const queryString = req.getQuery();
    const methodRaw = req.getMethod();

    // Use interned method string if available
    const method = UWebSocketsHttpServer.INTERNED_METHODS.get(methodRaw) || methodRaw.toUpperCase();

    // Optimized query parsing with pooled object
    let queryParams: Record<string, string>;
    if (queryString) {
      queryParams = this.poolManager.acquireQuery();
      // Query parsing without URLSearchParams overhead
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
    } else {
      queryParams = {};
    }

    // Optimized header parsing with pooled object
    const headers = this.poolManager.acquireHeaders();
    req.forEach((key: string, value: string) => {
      headers[key] = value;
    });

    const httpReq = {
      method,
      path: url,
      url: url,
      query: queryParams,
      params: {}, // Will be filled by route matching
      headers,
      body: null,
      ip: '', // Lazy - only compute if accessed
      requestId: this.requestTrackingEnabled ? this.poolManager.generateRequestId() : '', // ID generation (if enabled)
    } as HttpRequest;

    // Store pooled objects for cleanup
    (httpReq as any)._pooledQuery = queryParams;
    (httpReq as any)._pooledHeaders = headers;

    return httpReq;
  }

  // Optimized helper to write headers
  private static writeHeaders(res: any, headers: Record<string, string | string[]>): void {
    // Performance: for...in is the fastest way to iterate response headers
    for (const key in headers) {
      const value = headers[key];
      res.writeHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
  }

  // Helper to get status string (cached for performance)
  private static getStatusString(code: number): string {
    return UWebSocketsHttpServer.STATUS_STRINGS.get(code) || `${code} OK`;
  }

  // Pre-define methods on prototype instead of creating new closures for each request
  private static readonly ResponsePrototype = class {
    public headersSent = false;
    public statusCode = 200;
    public responseHeaders: Record<string, string | string[]> = {};
    private _res: any;
    private _req: any;
    private _logger: any;

    init(res: any, req: any, logger: any) {
      this.headersSent = false;
      this.statusCode = 200;
      // Clear headers object (reuse to avoid allocation)
      for (const key in this.responseHeaders) {
        delete this.responseHeaders[key];
      }
      this._res = res;
      this._req = req;
      this._logger = logger;
      return this;
    }

    status(code: number) {
      this.statusCode = code;
      return this;
    }

    setHeader(name: string, value: string | string[]) {
      this.responseHeaders[name.toLowerCase()] = value;
      return this;
    }

    getHeader(name: string) {
      return this.responseHeaders[name.toLowerCase()];
    }

    removeHeader(name: string) {
      const lowerName = name.toLowerCase();
      if (lowerName in this.responseHeaders) {
        delete this.responseHeaders[lowerName];
      }
      return this;
    }

    async json(data: any) {
      if (this.headersSent || this._res.aborted) return;

      // Fast-path JSON serialization for common API patterns
      let body: string;

      if (data && typeof data === 'object' && 'success' in data) {
        let keyCount = 0;
        let hasData = false;
        let hasError = false;
        let hasTotal = false;

        for (const key in data) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            keyCount++;
            if (key === 'data') hasData = true;
            else if (key === 'error') hasError = true;
            else if (key === 'total') hasTotal = true;
          }
        }

        if (keyCount === 3 && hasData && hasError) {
          body = `{"success":${data.success},"data":${JSON.stringify(data.data)},"error":${JSON.stringify(data.error)}}`;
        } else if (keyCount === 3 && hasData && hasTotal) {
          body = `{"success":${data.success},"data":${JSON.stringify(data.data)},"total":${data.total}}`;
        } else if (keyCount === 2 && hasData) {
          body = `{"success":${data.success},"data":${JSON.stringify(data.data)}}`;
        } else if (keyCount === 2 && hasError) {
          body = `{"success":${data.success},"error":${JSON.stringify(data.error)}}`;
        } else {
          body = JSON.stringify(data);
        }
      } else {
        body = JSON.stringify(data);
      }

      if (!('content-type' in this.responseHeaders)) {
        this.responseHeaders['content-type'] = 'application/json';
      }

      try {
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end(body);
        });
        this.headersSent = true;
      } catch {
        this._logger.error('Failed to send JSON response', 'ResponseError');
      }
    }

    send(data: string | Buffer) {
      if (this.headersSent || this._res.aborted) return;

      const body = typeof data === 'string' ? data : data.toString();

      try {
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end(body);
        });
        this.headersSent = true;
      } catch {
        this._logger.error('Failed to send response', 'ResponseError');
      }
    }

    end(data?: any, encoding?: any, callback?: any) {
      if (this.headersSent || this._res.aborted) {
        if (typeof callback === 'function') callback();
        return this;
      }

      try {
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(this.statusCode));
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end(data || '');
        });
        this.headersSent = true;
        if (typeof callback === 'function') callback();
      } catch {
        this._logger.error('Failed to end response', 'ResponseError');
        if (typeof callback === 'function') callback();
      }

      return this;
    }

    redirect(url: string, code?: number) {
      if (this.headersSent || this._res.aborted) return;

      const redirectCode = code || 302;
      this.statusCode = redirectCode;

      try {
        this._res.cork(() => {
          this._res.writeStatus(UWebSocketsHttpServer.getStatusString(redirectCode));
          this._res.writeHeader('Location', url);
          UWebSocketsHttpServer.writeHeaders(this._res, this.responseHeaders);
          this._res.end();
        });
        this.headersSent = true;
      } catch {
        this._logger.error('Failed to send redirect', 'ResponseError');
      }
    }

    // EventEmitter stubs for middleware compatibility
    on(_event: string, _callback: (...args: any[]) => void) {
      return this;
    }

    once(_event: string, _callback: (...args: any[]) => void) {
      return this;
    }

    emit(_event: string, ..._args: any[]) {
      return true;
    }

    removeListener(_event: string, _callback: (...args: any[]) => void) {
      return this;
    }

    cookie(name: string, value: string, options?: any) {
      // Optimized: Build cookie string with array join for better performance
      const parts = [name, '=', value];

      if (options) {
        if (options.maxAge) {
          parts.push('; Max-Age=', String(options.maxAge));
        }
        if (options.domain) {
          parts.push('; Domain=', options.domain);
        }
        if (options.path) {
          parts.push('; Path=', options.path);
        }
        if (options.secure) {
          parts.push('; Secure');
        }
        if (options.httpOnly) {
          parts.push('; HttpOnly');
        }
        if (options.sameSite) {
          parts.push('; SameSite=', options.sameSite);
        }
      }

      const cookie = parts.join('');
      const lowerKey = 'set-cookie';
      const existing = this.responseHeaders[lowerKey];
      if (existing) {
        if (Array.isArray(existing)) {
          existing.push(cookie);
        } else {
          this.responseHeaders[lowerKey] = [existing as string, cookie];
        }
      } else {
        this.responseHeaders[lowerKey] = cookie;
      }

      return this;
    }
  };

  // Object pool for response objects (further optimization)
  private responsePool: InstanceType<typeof UWebSocketsHttpServer.ResponsePrototype>[] = [];
  private readonly MAX_RESPONSE_POOL_SIZE = 100;

  private createMoroResponse(req: any, res: any): HttpResponse {
    const httpRes =
      this.responsePool.length > 0
        ? (this.responsePool.pop() as InstanceType<typeof UWebSocketsHttpServer.ResponsePrototype>)
        : new UWebSocketsHttpServer.ResponsePrototype();

    httpRes.init(res, req, this.logger);
    return httpRes as any as HttpResponse;
  }

  private releaseResponse(httpRes: HttpResponse) {
    // Return response object to pool for reuse
    if (this.responsePool.length < this.MAX_RESPONSE_POOL_SIZE) {
      this.responsePool.push(httpRes as any);
    }
  }

  private async readBody(res: any, httpReq: HttpRequest): Promise<void> {
    return new Promise(resolve => {
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
          } catch {
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

  // Public API - matches MoroHttpServer interface

  use(middleware: Middleware): void {
    this.globalMiddleware.push(middleware);
  }

  // Configure request tracking (ID generation)
  setRequestTracking(enabled: boolean): void {
    this.requestTrackingEnabled = enabled;
  }

  // Note: Route registration methods (get, post, etc.) are not used by uWebSockets adapter
  // All routing is handled by UnifiedRouter through the middleware chain

  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  configurePerformance(_config: any): void {
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

  close(callback?: (error?: Error) => void): void {
    if (!this.isListening) {
      if (callback) callback();
      return;
    }

    try {
      // Close the listen socket first
      if (this.listenSocket && this.uws) {
        this.uws.us_listen_socket_close(this.listenSocket);
        this.listenSocket = null;
        this.isListening = false;
        this.logger.info('uWebSockets listen socket closed', 'Close');
      }

      // Clear middleware to break references
      this.globalMiddleware = [];

      // Clear the app reference to release uWebSockets resources
      // This is critical for worker thread cleanup
      if (this.app) {
        // Remove any route handlers
        this.app = null;
      }

      if (callback) {
        // Give the event loop time to process any pending uWebSockets events
        // before invoking the callback. This ensures handles are properly closed.
        setTimeout(() => {
          callback();
        }, 50);
      }
    } catch (error) {
      this.logger.error('Error closing server', 'Close', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (callback) callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getServer(): any {
    // Return the uWebSockets app for direct access if needed
    return this.app;
  }

  getApp(): any {
    return this.app;
  }

  // Get app descriptor for worker thread clustering
  getDescriptor(): any {
    if (!this.app || typeof this.app.getDescriptor !== 'function') {
      throw new Error('uWebSockets app does not support getDescriptor()');
    }
    return this.app.getDescriptor();
  }

  // Add child app descriptor for acceptor pattern
  addChildAppDescriptor(descriptor: any): void {
    if (!this.app || typeof this.app.addChildAppDescriptor !== 'function') {
      throw new Error('uWebSockets app does not support addChildAppDescriptor()');
    }
    this.app.addChildAppDescriptor(descriptor);
  }

  forceCleanup(): void {
    // Cleanup method for compatibility
    this.logger.debug('Force cleanup called', 'Cleanup');
  }
}
