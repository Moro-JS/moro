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

        if (pooledQuery && Object.keys(pooledQuery).length > 0) {
          this.poolManager.releaseQuery(pooledQuery);
        }

        if (pooledHeaders && Object.keys(pooledHeaders).length > 0) {
          this.poolManager.releaseHeaders(pooledHeaders);
        }
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
      const lowerKey = key.toLowerCase();
      headers[lowerKey] = value;
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

  // Optimized helper to write headers - avoids Object.entries() overhead
  private static writeHeaders(
    res: any,
    headers: Record<string, string | string[]>,
    headerKeys: string[]
  ): void {
    const len = headerKeys.length;
    // Fast-path for common cases
    if (len === 0) return;

    if (len === 1) {
      // Single header (most common case) - no loop needed
      const key = headerKeys[0];
      const value = headers[key];
      res.writeHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
      return;
    }

    if (len === 2) {
      // Two headers - unroll loop
      const key0 = headerKeys[0];
      const value0 = headers[key0];
      res.writeHeader(key0, Array.isArray(value0) ? value0.join(', ') : String(value0));

      const key1 = headerKeys[1];
      const value1 = headers[key1];
      res.writeHeader(key1, Array.isArray(value1) ? value1.join(', ') : String(value1));
      return;
    }

    // Multiple headers - use loop
    for (let i = 0; i < len; i++) {
      const key = headerKeys[i];
      const value = headers[key];
      res.writeHeader(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
  }

  // Helper to get status string (cached for performance)
  private static getStatusString(code: number): string {
    return UWebSocketsHttpServer.STATUS_STRINGS.get(code) || `${code} OK`;
  }

  private createMoroResponse(req: any, res: any): HttpResponse {
    let headersSent = false;
    let statusCode = 200;
    const responseHeaders: Record<string, string | string[]> = {};
    let headerKeys: string[] = []; // Track header keys for fast iteration
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
        const lowerName = name.toLowerCase();
        if (!(lowerName in responseHeaders)) {
          headerKeys.push(lowerName);
        }
        responseHeaders[lowerName] = value;
        return httpRes as HttpResponse;
      },

      getHeader(name: string) {
        return responseHeaders[name.toLowerCase()];
      },

      removeHeader(name: string) {
        const lowerName = name.toLowerCase();
        if (lowerName in responseHeaders) {
          delete responseHeaders[lowerName];
          headerKeys = headerKeys.filter(k => k !== lowerName);
        }
        return httpRes as HttpResponse;
      },

      async json(data: any) {
        if (headersSent || res.aborted) return;

        const body = JSON.stringify(data);

        // Set content-type if not already set
        if (!('content-type' in responseHeaders)) {
          responseHeaders['content-type'] = 'application/json';
          headerKeys.push('content-type');
        }

        try {
          res.cork(() => {
            res.writeStatus(UWebSocketsHttpServer.getStatusString(statusCode));
            UWebSocketsHttpServer.writeHeaders(res, responseHeaders, headerKeys);
            res.end(body);
          });
          headersSent = true;
        } catch {
          self.logger.error('Failed to send JSON response', 'ResponseError');
        }
      },

      send(data: string | Buffer) {
        if (headersSent || res.aborted) return;

        const body = typeof data === 'string' ? data : data.toString();

        try {
          res.cork(() => {
            res.writeStatus(UWebSocketsHttpServer.getStatusString(statusCode));
            UWebSocketsHttpServer.writeHeaders(res, responseHeaders, headerKeys);
            res.end(body);
          });
          headersSent = true;
        } catch {
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
            res.writeStatus(UWebSocketsHttpServer.getStatusString(statusCode));
            UWebSocketsHttpServer.writeHeaders(res, responseHeaders, headerKeys);
            res.end(data || '');
          });
          headersSent = true;
          if (typeof callback === 'function') callback();
        } catch {
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
            res.writeStatus(UWebSocketsHttpServer.getStatusString(redirectCode));
            res.writeHeader('Location', url);
            // Write any existing headers
            UWebSocketsHttpServer.writeHeaders(res, responseHeaders, headerKeys);
            res.end();
          });
          headersSent = true;
        } catch {
          self.logger.error('Failed to send redirect', 'ResponseError');
        }
      },

      // EventEmitter compatibility - stub implementations for middleware
      on(_event: string, _callback: (...args: any[]) => void) {
        // uWebSockets doesn't use events like Node.js, but middleware might try to listen
        // Only implement 'finish' and 'close' events as stubs
        return httpRes;
      },

      once(_event: string, _callback: (...args: any[]) => void) {
        return httpRes;
      },

      emit(_event: string, ..._args: any[]) {
        return true;
      },

      removeListener(_event: string, _callback: (...args: any[]) => void) {
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

        const lowerKey = 'set-cookie';
        const existing = responseHeaders[lowerKey];
        if (existing) {
          if (Array.isArray(existing)) {
            responseHeaders[lowerKey] = [...existing, cookie];
          } else {
            responseHeaders[lowerKey] = [existing as string, cookie];
          }
        } else {
          responseHeaders[lowerKey] = cookie;
          headerKeys.push(lowerKey);
        }

        return httpRes as HttpResponse;
      },
    } as any;

    return httpRes as HttpResponse;
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
    } catch {
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
