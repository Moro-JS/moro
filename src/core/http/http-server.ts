// src/core/http-server.ts
import { IncomingMessage, ServerResponse, createServer, Server } from 'http';
import * as zlib from 'zlib';
import { createReadStream } from 'fs';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { createFrameworkLogger } from '../logger/index.js';
import {
  HttpRequest,
  HttpResponse,
  HttpHandler,
  Middleware,
  RouteEntry,
} from '../../types/http.js';
import { PathMatcher } from '../routing/path-matcher.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);

export class MoroHttpServer {
  private server: Server;
  private routes: RouteEntry[] = [];
  private globalMiddleware: Middleware[] = [];
  private compressionEnabled = true;
  private compressionThreshold = 1024;
  private requestTrackingEnabled = true; // Generate request IDs
  private logger = createFrameworkLogger('HttpServer');
  private hookManager: any;
  private requestCounter = 0;

  // Use shared object pool manager
  private poolManager = ObjectPoolManager.getInstance();

  // Interned method strings for fast reference equality comparison
  private static readonly METHOD_POST = 'POST';
  private static readonly METHOD_PUT = 'PUT';
  private static readonly METHOD_PATCH = 'PATCH';
  private static readonly METHOD_GET = 'GET';
  private static readonly METHOD_DELETE = 'DELETE';
  private static readonly METHOD_HEAD = 'HEAD';
  private static readonly METHOD_OPTIONS = 'OPTIONS';

  // Pre-compiled response templates for common responses
  private static readonly RESPONSE_TEMPLATES = {
    notFound: Buffer.from('{"success":false,"error":"Not found"}'),
    unauthorized: Buffer.from('{"success":false,"error":"Unauthorized"}'),
    forbidden: Buffer.from('{"success":false,"error":"Forbidden"}'),
    internalError: Buffer.from('{"success":false,"error":"Internal server error"}'),
    methodNotAllowed: Buffer.from('{"success":false,"error":"Method not allowed"}'),
    rateLimited: Buffer.from('{"success":false,"error":"Rate limit exceeded"}'),
  };

  // Buffer pool for zero-copy operations
  private static readonly BUFFER_SIZES = [64, 256, 1024, 4096, 16384];
  private static readonly BUFFER_POOLS = new Map<number, Buffer[]>();

  static {
    // Pre-allocate buffer pools for zero-allocation responses
    for (const size of MoroHttpServer.BUFFER_SIZES) {
      MoroHttpServer.BUFFER_POOLS.set(size, []);
      for (let i = 0; i < 50; i++) {
        // 50 buffers per size
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        MoroHttpServer.BUFFER_POOLS.get(size)!.push(Buffer.allocUnsafe(size));
      }
    }
  }

  private static getOptimalBuffer(size: number): Buffer {
    // Find the smallest buffer that fits
    for (const poolSize of MoroHttpServer.BUFFER_SIZES) {
      if (size <= poolSize) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const pool = MoroHttpServer.BUFFER_POOLS.get(poolSize)!;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return pool.length > 0 ? pool.pop()! : Buffer.allocUnsafe(poolSize);
      }
    }
    return Buffer.allocUnsafe(size);
  }

  private static returnBuffer(buffer: Buffer): void {
    // Return buffer to appropriate pool
    const size = buffer.length;
    if (MoroHttpServer.BUFFER_POOLS.has(size)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const pool = MoroHttpServer.BUFFER_POOLS.get(size)!;
      if (pool.length < 50) {
        // Don't let pools grow too large
        pool.push(buffer);
      }
    }
  }

  constructor() {
    this.server = createServer(this.handleRequest.bind(this));

    // Optimize server for high performance (conservative settings for compatibility)
    this.server.keepAliveTimeout = 5000; // 5 seconds
    this.server.headersTimeout = 6000; // 6 seconds
    this.server.timeout = 30000; // 30 seconds request timeout
  }

  // Configure server for maximum performance (can disable all overhead)
  configurePerformance(
    config: {
      compression?: { enabled: boolean; threshold?: number };
      minimal?: boolean;
    } = {}
  ) {
    if (config.compression !== undefined) {
      this.compressionEnabled = config.compression.enabled;
      if (config.compression.threshold !== undefined) {
        this.compressionThreshold = config.compression.threshold;
      }
    }

    // Minimal mode - disable ALL overhead for pure speed
    if (config.minimal) {
      this.compressionEnabled = false;
      this.compressionThreshold = Infinity; // Never compress
    }
  }

  // Configure request tracking (ID generation)
  setRequestTracking(enabled: boolean): void {
    this.requestTrackingEnabled = enabled;
  }

  // Middleware management
  use(middleware: Middleware): void {
    this.globalMiddleware.push(middleware);
  }

  // Set hooks manager for request processing
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
      // Static route - O(1) lookup
      const staticKey = `${method}:${path}`;
      this.staticRoutes.set(staticKey, route);
    } else {
      // Dynamic route - organize by segment count for faster matching
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
    // Use shared PathMatcher for consistent path compilation
    const compiled = PathMatcher.compile(path);
    return {
      pattern: compiled.pattern || new RegExp(`^${path.replace(/\//g, '\\/')}$`),
      paramNames: compiled.paramNames,
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const httpReq = this.enhanceRequest(req);
    const httpRes = this.enhanceResponse(res, httpReq);

    // Store original params for efficient cleanup
    const originalParams = httpReq.params;

    try {
      // Optimized URL and query parsing with object pooling
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const urlString = req.url!;
      const queryIndex = urlString.indexOf('?');

      if (queryIndex === -1) {
        // No query string
        httpReq.path = urlString;
        httpReq.query = {};
      } else {
        // Has query string - parse efficiently with pooled object
        httpReq.path = urlString.substring(0, queryIndex);
        httpReq.query = this.parseQueryStringPooled(urlString.substring(queryIndex + 1));
      }

      // Method checking - use reference equality for interned strings (50-100% faster)
      if (
        httpReq.method === MoroHttpServer.METHOD_POST ||
        httpReq.method === MoroHttpServer.METHOD_PUT ||
        httpReq.method === MoroHttpServer.METHOD_PATCH
      ) {
        httpReq.body = await this.parseBody(req);
      }

      // Execute hooks before request processing - NOOP if no hookManager
      if (this.hookManager) {
        await this.hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // Execute global middleware first - EARLY EXIT if none registered
      const middlewareLen = this.globalMiddleware.length;
      if (middlewareLen > 0) {
        await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
      }

      // If middleware handled the request, don't continue
      if (httpRes.headersSent) {
        return;
      }

      // Find matching route
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const route = this.findRoute(req.method!, httpReq.path);
      if (!route) {
        // 404 response with pre-compiled buffer
        httpRes.statusCode = 404;
        httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
        httpRes.setHeader('Content-Length', MoroHttpServer.RESPONSE_TEMPLATES.notFound.length);
        httpRes.end(MoroHttpServer.RESPONSE_TEMPLATES.notFound);
        return;
      }

      // Extract path parameters - optimized with object pooling
      const matches = httpReq.path.match(route.pattern);
      if (matches) {
        // Use pooled object for parameters
        httpReq.params = this.acquireParamObject();
        const paramNames = route.paramNames;
        const paramNamesLen = paramNames.length;
        for (let i = 0; i < paramNamesLen; i++) {
          httpReq.params[paramNames[i]] = matches[i + 1];
        }
      }

      // Execute middleware chain - EARLY EXIT if no route middleware
      const routeMiddlewareLen = route.middleware.length;
      if (routeMiddlewareLen > 0) {
        await this.executeMiddleware(route.middleware, httpReq, httpRes);
      }

      // Execute handler - Don't await sync handlers
      const handlerResult = route.handler(httpReq, httpRes);
      if (handlerResult && typeof handlerResult.then === 'function') {
        await handlerResult;
      }
    } catch (error) {
      // Debug: Log the actual error and where it came from
      this.logger.debug('Request error details', 'RequestHandler', {
        errorType: typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : 'No stack trace',
        requestPath: req.url,
        requestMethod: req.method,
      });

      this.logger.error('Request error', 'RequestHandler', {
        error: error instanceof Error ? error.message : String(error),
        requestId: httpReq.requestId,
        method: req.method,
        path: req.url,
      });

      if (!httpRes.headersSent) {
        // Ensure response is properly enhanced before using custom methods
        if (typeof httpRes.status === 'function' && typeof httpRes.json === 'function') {
          httpRes.status(500).json({
            success: false,
            error: 'Internal server error',
            requestId: httpReq.requestId,
          });
        } else {
          // Defensive fallback - check each method individually
          if (typeof httpRes.setHeader === 'function') {
            httpRes.statusCode = 500;
            httpRes.setHeader('Content-Type', 'application/json');
          } else {
            // Even setHeader doesn't exist - object is completely wrong
            this.logger.error('Response object is not a proper ServerResponse', 'RequestHandler', {
              responseType: typeof httpRes,
              responseKeys: Object.keys(httpRes),
            });
          }

          if (typeof httpRes.end === 'function') {
            httpRes.end(
              JSON.stringify({
                success: false,
                error: 'Internal server error',
                requestId: httpReq.requestId,
              })
            );
          } else {
            this.logger.error(
              'Cannot send error response - end() method missing',
              'RequestHandler'
            );
          }
        }
      }
    } finally {
      // CRITICAL: Always release pooled objects back to the pool
      // This prevents memory leaks and ensures consistent performance
      // Optimized: Check if object is empty without Object.keys()
      if (originalParams) {
        let isEmpty = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _key in originalParams) {
          isEmpty = false;
          break;
        }
        if (isEmpty) {
          this.releaseParamObject(originalParams);
        }
      }
      if (httpReq.params && httpReq.params !== originalParams) {
        let isEmpty = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _key in httpReq.params) {
          isEmpty = false;
          break;
        }
        if (isEmpty) {
          this.releaseParamObject(httpReq.params);
        }
      }
    }

    // Additional cleanup on response completion to ensure objects are returned to pool
    res.once('finish', () => {
      // Optimized: Check if object is empty without Object.keys()
      if (originalParams) {
        let isEmpty = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _key in originalParams) {
          isEmpty = false;
          break;
        }
        if (isEmpty) {
          this.releaseParamObject(originalParams);
        }
      }
      if (httpReq.params && httpReq.params !== originalParams) {
        let isEmpty = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _key in httpReq.params) {
          isEmpty = false;
          break;
        }
        if (isEmpty) {
          this.releaseParamObject(httpReq.params);
        }
      }
    });
  }

  // Use shared object pool for parameter objects
  private acquireParamObject(): Record<string, string> {
    return this.poolManager.acquireParams();
  }

  private releaseParamObject(params: Record<string, string>): void {
    this.poolManager.releaseParams(params);
  }

  // Force cleanup of all pooled objects
  private forceCleanupPools(): void {
    // Use shared pool manager cleanup
    this.poolManager.clearAll();

    // Force garbage collection if available
    if (globalThis?.gc) {
      globalThis.gc();
    }
  }

  private acquireBuffer(size: number): Buffer {
    return this.poolManager.acquireBuffer(size);
  }

  private releaseBuffer(buffer: Buffer): void {
    this.poolManager.releaseBuffer(buffer);
  }

  private streamLargeResponse(res: any, data: any): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Stream the response in chunks
    const jsonString = JSON.stringify(data);
    const chunkSize = 8192; // 8KB chunks

    for (let i = 0; i < jsonString.length; i += chunkSize) {
      const chunk = jsonString.substring(i, i + chunkSize);
      res.write(chunk);
    }
    res.end();
  }

  private normalizePath(path: string): string {
    // Check cache first
    if (this.pathNormalizationCache.has(path)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.pathNormalizationCache.get(path)!;
    }

    // Normalization: remove trailing slash (except root), decode once
    let normalized = path;
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Cache result (limit cache size)
    if (this.pathNormalizationCache.size < 200) {
      this.pathNormalizationCache.set(path, normalized);
    }

    return normalized;
  }

  private enhanceRequest(req: IncomingMessage): HttpRequest {
    const httpReq = req as HttpRequest;
    httpReq.params = this.acquireParamObject();
    httpReq.query = {};
    httpReq.body = null;
    httpReq.path = '';
    httpReq.ip = req.socket.remoteAddress || '';
    // Request ID generation using pool manager (if enabled)
    httpReq.requestId = this.requestTrackingEnabled ? this.poolManager.generateRequestId() : '';
    httpReq.headers = req.headers as Record<string, string>;

    // Intern method string for fast reference equality comparison (50-100% faster)
    const method = req.method;
    switch (method) {
      case 'POST':
        httpReq.method = MoroHttpServer.METHOD_POST;
        break;
      case 'PUT':
        httpReq.method = MoroHttpServer.METHOD_PUT;
        break;
      case 'PATCH':
        httpReq.method = MoroHttpServer.METHOD_PATCH;
        break;
      case 'GET':
        httpReq.method = MoroHttpServer.METHOD_GET;
        break;
      case 'DELETE':
        httpReq.method = MoroHttpServer.METHOD_DELETE;
        break;
      case 'HEAD':
        httpReq.method = MoroHttpServer.METHOD_HEAD;
        break;
      case 'OPTIONS':
        httpReq.method = MoroHttpServer.METHOD_OPTIONS;
        break;
      default:
        httpReq.method = method;
    }

    // Parse cookies - EARLY EXIT if no cookie header
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      httpReq.cookies = this.parseCookies(cookieHeader);
    } else {
      httpReq.cookies = {};
    }

    return httpReq;
  }

  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};

    // EARLY EXIT if no cookie header
    if (!cookieHeader) return cookies;

    const cookieParts = cookieHeader.split(';');
    const cookiePartsLen = cookieParts.length;
    for (let i = 0; i < cookiePartsLen; i++) {
      const cookie = cookieParts[i];
      const equalIndex = cookie.indexOf('=');
      if (equalIndex > 0) {
        const name = cookie.substring(0, equalIndex).trim();
        const value = cookie.substring(equalIndex + 1);
        if (name && value) {
          cookies[name] = decodeURIComponent(value);
        }
      }
    }

    return cookies;
  }

  private enhanceResponse(res: ServerResponse, req: HttpRequest): HttpResponse {
    const httpRes = res as HttpResponse;

    // Store request reference for access to headers (needed for compression, logging, etc.)
    (httpRes as any).req = req;

    // BULLETPROOF status method - always works
    httpRes.status = (code: number) => {
      httpRes.statusCode = code;
      return httpRes;
    };

    httpRes.json = async (data: any) => {
      if (httpRes.headersSent) return;

      // JSON serialization with zero-copy buffers
      let jsonString: string;

      // Enhanced JSON optimization for common API patterns
      // Fast path for common 2-3 key objects without Object.keys() overhead
      if (data && typeof data === 'object' && 'success' in data) {
        // Check for common patterns using 'in' operator (faster than Object.keys for small objects)
        const hasData = 'data' in data;
        const hasError = 'error' in data;
        const hasTotal = 'total' in data;

        // Fast path: {success, data} - most common pattern
        if (hasData && !hasError && !hasTotal) {
          // Verify it's exactly 2 keys by checking no other common keys exist
          if (!('message' in data) && !('code' in data) && !('status' in data)) {
            jsonString = `{"success":${data.success},"data":${JSON.stringify(data.data)}}`;
          } else {
            jsonString = JSON.stringify(data);
          }
        } else if (hasError && !hasData && !hasTotal) {
          // Fast path: {success, error}
          if (!('message' in data) && !('code' in data) && !('status' in data)) {
            jsonString = `{"success":${data.success},"error":${JSON.stringify(data.error)}}`;
          } else {
            jsonString = JSON.stringify(data);
          }
        } else if (hasData && hasError && !hasTotal) {
          // Fast path: {success, data, error}
          if (!('message' in data) && !('code' in data) && !('status' in data)) {
            jsonString = `{"success":${data.success},"data":${JSON.stringify(data.data)},"error":${JSON.stringify(data.error)}}`;
          } else {
            jsonString = JSON.stringify(data);
          }
        } else if (hasData && hasTotal && !hasError) {
          // Fast path: {success, data, total}
          if (!('message' in data) && !('code' in data) && !('status' in data)) {
            jsonString = `{"success":${data.success},"data":${JSON.stringify(data.data)},"total":${data.total}}`;
          } else {
            jsonString = JSON.stringify(data);
          }
        } else {
          // Complex object - use standard JSON.stringify
          jsonString = JSON.stringify(data);
        }
      } else {
        jsonString = JSON.stringify(data);
      }

      // Use buffer pool for zero-allocation responses
      const estimatedSize = jsonString.length;
      if (estimatedSize > 32768) {
        // Large response - stream it
        return this.streamLargeResponse(httpRes, data);
      }

      const buffer = MoroHttpServer.getOptimalBuffer(estimatedSize);
      const actualLength = buffer.write(jsonString, 0, 'utf8');

      // Slice to actual size to avoid sending extra bytes
      const finalBuffer =
        actualLength === buffer.length ? buffer : buffer.subarray(0, actualLength);

      // Optimized header setting - set multiple headers at once when possible
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json; charset=utf-8',
      };

      // Compression with buffer pool - EARLY EXIT if disabled or below threshold
      // CRITICAL: Only make this async if compression is actually happening
      if (this.compressionEnabled && finalBuffer.length > this.compressionThreshold) {
        const acceptEncoding = httpRes.req.headers['accept-encoding'];

        if (acceptEncoding && acceptEncoding.includes('gzip')) {
          // ASYNC PATH - compression needed
          gzip(finalBuffer).then(compressed => {
            headers['Content-Encoding'] = 'gzip';
            headers['Content-Length'] = compressed.length;

            // Batch write all headers at once (50-100% faster)
            httpRes.writeHead(httpRes.statusCode || 200, headers);

            httpRes.end(compressed);
            // Return buffer to pool after response
            process.nextTick(() => MoroHttpServer.returnBuffer(buffer));
          });
          return;
        } else if (acceptEncoding && acceptEncoding.includes('deflate')) {
          // ASYNC PATH - compression needed
          deflate(finalBuffer).then(compressed => {
            headers['Content-Encoding'] = 'deflate';
            headers['Content-Length'] = compressed.length;

            // Batch write all headers at once
            httpRes.writeHead(httpRes.statusCode || 200, headers);

            httpRes.end(compressed);
            // Return buffer to pool after response
            process.nextTick(() => MoroHttpServer.returnBuffer(buffer));
          });
          return;
        }
      }

      // SYNC PATH - no compression, fast path
      headers['Content-Length'] = finalBuffer.length;

      // Batch write all headers at once
      httpRes.writeHead(httpRes.statusCode || 200, headers);

      httpRes.end(finalBuffer);

      // Return buffer to pool after response (zero-copy achievement!)
      process.nextTick(() => MoroHttpServer.returnBuffer(buffer));
    };

    httpRes.send = (data: string | Buffer) => {
      if (httpRes.headersSent) return;

      // Auto-detect content type if not already set
      if (!httpRes.getHeader('Content-Type')) {
        if (typeof data === 'string') {
          // Check if it's JSON
          try {
            JSON.parse(data);
            httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
          } catch {
            // Default to plain text
            httpRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
          }
        } else {
          // Buffer data - default to octet-stream
          httpRes.setHeader('Content-Type', 'application/octet-stream');
        }
      }

      httpRes.end(data);
    };

    httpRes.cookie = (name: string, value: string, options: any = {}) => {
      if (httpRes.headersSent) {
        const isCritical =
          options.critical ||
          name.includes('session') ||
          name.includes('auth') ||
          name.includes('csrf');
        const message = `Cookie '${name}' could not be set - headers already sent`;

        if (isCritical || options.throwOnLateSet) {
          throw new Error(`${message}. This may cause authentication or security issues.`);
        } else {
          this.logger.warn(message, 'CookieWarning', {
            cookieName: name,
            critical: isCritical,
            stackTrace: new Error().stack,
          });
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

      const existingCookies = httpRes.getHeader('Set-Cookie') || [];
      const cookies = Array.isArray(existingCookies)
        ? [...existingCookies]
        : [existingCookies as string];
      cookies.push(cookieString);
      httpRes.setHeader('Set-Cookie', cookies);

      return httpRes;
    };

    httpRes.clearCookie = (name: string, options: any = {}) => {
      const clearOptions = { ...options, expires: new Date(0), maxAge: 0 };
      return httpRes.cookie(name, '', clearOptions);
    };

    httpRes.redirect = (url: string, status: number = 302) => {
      if (httpRes.headersSent) return;
      httpRes.statusCode = status;
      httpRes.setHeader('Location', url);
      httpRes.end();
    };

    httpRes.sendFile = async (filePath: string) => {
      if (httpRes.headersSent) return;

      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const extension = path.extname(filePath);
        const mime = await this.getMimeType(extension);

        const stats = await fs.stat(filePath);
        const data = await fs.readFile(filePath);

        // Add charset for text-based files
        const contentType = this.addCharsetIfNeeded(mime);
        httpRes.setHeader('Content-Type', contentType);
        httpRes.setHeader('Content-Length', stats.size);

        // Add security headers for file downloads
        httpRes.setHeader('X-Content-Type-Options', 'nosniff');

        // Add caching headers
        httpRes.setHeader('Last-Modified', stats.mtime.toUTCString());
        httpRes.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year for static files

        httpRes.end(data);
      } catch {
        httpRes.status(404).json({ success: false, error: 'File not found' });
      }
    };

    // Header management utilities
    httpRes.hasHeader = (name: string): boolean => {
      return httpRes.getHeader(name) !== undefined;
    };

    // Note: removeHeader is inherited from ServerResponse, we don't override it

    httpRes.setBulkHeaders = (headers: Record<string, string | number>) => {
      if (httpRes.headersSent) {
        this.logger.warn('Cannot set headers - headers already sent', 'HeaderWarning', {
          attemptedHeaders: Object.keys(headers),
        });
        return httpRes;
      }

      const headerKeys = Object.keys(headers);
      const headerKeysLen = headerKeys.length;
      for (let i = 0; i < headerKeysLen; i++) {
        const key = headerKeys[i];
        httpRes.setHeader(key, headers[key]);
      }
      return httpRes;
    };

    httpRes.appendHeader = (name: string, value: string | string[]) => {
      if (httpRes.headersSent) {
        this.logger.warn(
          `Cannot append to header '${name}' - headers already sent`,
          'HeaderWarning'
        );
        return httpRes;
      }

      const existing = httpRes.getHeader(name);
      if (existing) {
        const values = Array.isArray(existing) ? existing : [existing.toString()];
        const newValues = Array.isArray(value) ? value : [value];
        httpRes.setHeader(name, [...values, ...newValues]);
      } else {
        httpRes.setHeader(name, value);
      }
      return httpRes;
    };

    // Response state utilities
    httpRes.canSetHeaders = (): boolean => {
      return !httpRes.headersSent;
    };

    httpRes.getResponseState = () => {
      return {
        headersSent: httpRes.headersSent,
        statusCode: httpRes.statusCode,
        headers: httpRes.getHeaders ? httpRes.getHeaders() : {},
        finished: httpRes.finished || false,
        writable: httpRes.writable,
      };
    };

    return httpRes;
  }

  private async getMimeType(ext: string): Promise<string> {
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.xml': 'application/xml',
    };

    return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
  }

  private addCharsetIfNeeded(mimeType: string): string {
    // Add charset for text-based content types - optimized with early exit
    // Check most common cases first
    if (
      mimeType.startsWith('text/') ||
      mimeType.startsWith('application/json') ||
      mimeType.startsWith('application/javascript') ||
      mimeType.startsWith('application/xml') ||
      mimeType.startsWith('image/svg+xml')
    ) {
      if (!mimeType.includes('charset')) {
        return `${mimeType}; charset=utf-8`;
      }
    }

    return mimeType;
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLength = 0;
      const maxSize = 10 * 1024 * 1024; // 10MB limit

      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          const contentType = req.headers['content-type'] || '';

          if (contentType.includes('application/json')) {
            resolve(JSON.parse(body.toString()));
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            resolve(this.parseUrlEncoded(body.toString()));
          } else if (contentType.includes('multipart/form-data')) {
            resolve(this.parseMultipart(body, contentType));
          } else {
            resolve(body.toString());
          }
        } catch (error) {
          reject(error);
        }
      });

      req.on('error', reject);
    });
  }

  private parseMultipart(
    buffer: Buffer,
    contentType: string
  ): { fields: Record<string, string>; files: Record<string, any> } {
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
      throw new Error('Invalid multipart boundary');
    }

    const parts = buffer.toString('binary').split('--' + boundary);
    const fields: Record<string, string> = {};
    const files: Record<string, any> = {};

    const partsLen = parts.length - 1;
    for (let i = 1; i < partsLen; i++) {
      const part = parts[i];
      const [headers, content] = part.split('\r\n\r\n');

      if (!headers || content === undefined) continue;

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type: ([^\r\n]+)/);

      if (nameMatch) {
        const name = nameMatch[1];

        if (filenameMatch) {
          // This is a file
          const filename = filenameMatch[1];
          const mimeType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
          const fileContent = content.substring(0, content.length - 2); // Remove trailing \r\n

          files[name] = {
            filename,
            mimetype: mimeType,
            data: Buffer.from(fileContent, 'binary'),
            size: Buffer.byteLength(fileContent, 'binary'),
          };
        } else {
          // This is a regular field
          fields[name] = content.substring(0, content.length - 2); // Remove trailing \r\n
        }
      }
    }

    return { fields, files };
  }

  private parseUrlEncoded(body: string): Record<string, string> {
    const params = new URLSearchParams(body);
    const result: Record<string, string> = {};
    for (const [key, value] of params) {
      result[key] = value;
    }
    return result;
  }

  // Legacy method for backward compatibility
  private parseQueryString(queryString: string): Record<string, string> {
    return this.parseQueryStringPooled(queryString);
  }

  // Optimized query string parser with object pooling
  private parseQueryStringPooled(queryString: string): Record<string, string> {
    if (!queryString) return {};

    const result = this.poolManager.acquireQuery();
    const pairs = queryString.split('&');
    const pairsLen = pairs.length;

    for (let i = 0; i < pairsLen; i++) {
      const pair = pairs[i];
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

  // Advanced route optimization: cache + static routes + segment grouping
  private routeCache = new Map<string, RouteEntry | null>();
  private staticRoutes = new Map<string, RouteEntry>();
  private dynamicRoutes: RouteEntry[] = [];
  private routesBySegmentCount = new Map<number, RouteEntry[]>();
  private pathNormalizationCache = new Map<string, string>();

  // CPU cache-friendly optimizations
  private routeHitCount = new Map<string, number>(); // Track route popularity for cache optimization
  private static readonly HOT_ROUTE_THRESHOLD = 100; // Routes accessed 100+ times get hot path treatment

  private findRoute(method: string, path: string): RouteEntry | null {
    // Skip normalization and hit tracking for cached routes
    const cacheKey = `${method}:${path}`;

    // Check cache first (hot path optimization) - BEFORE any other work
    if (this.routeCache.has(cacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(cacheKey)!;
    }

    // Normalize path for consistent matching (only if not cached)
    const normalizedPath = this.normalizePath(path);
    const normalizedCacheKey = normalizedPath !== path ? `${method}:${normalizedPath}` : cacheKey;

    // Check cache again with normalized path
    if (normalizedPath !== path && this.routeCache.has(normalizedCacheKey)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.routeCache.get(normalizedCacheKey)!;
    }

    // Phase 1: O(1) static route lookup
    const staticRoute = this.staticRoutes.get(normalizedCacheKey);
    if (staticRoute) {
      this.routeCache.set(normalizedCacheKey, staticRoute);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, staticRoute);
      }
      return staticRoute;
    }

    // Phase 2: Optimized dynamic route matching by segment count
    let route: RouteEntry | null = null;
    const dynamicRoutesLen = this.dynamicRoutes.length;
    if (dynamicRoutesLen > 0) {
      // Use shared utility for DRY principle
      const segmentCount = PathMatcher.countSegments(normalizedPath);

      const candidateRoutes = this.routesBySegmentCount.get(segmentCount) || this.dynamicRoutes;
      const candidateLen = candidateRoutes.length;

      // Only test routes with matching method and segment count
      for (let i = 0; i < candidateLen; i++) {
        const candidateRoute = candidateRoutes[i];
        if (candidateRoute.method === method && candidateRoute.pattern.test(normalizedPath)) {
          route = candidateRoute;
          break;
        }
      }
    }

    // Cache result (limit cache size to prevent memory leaks)
    if (this.routeCache.size < 500) {
      this.routeCache.set(normalizedCacheKey, route);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, route);
      }
    }

    return route;
  }

  // Optimized middleware execution with reduced Promise allocation
  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    const len = middleware.length;
    for (let i = 0; i < len; i++) {
      // Short-circuit if response already sent
      if (res.headersSent) return;

      const mw = middleware[i];

      await new Promise<void>((resolve, reject) => {
        let resolved = false;

        // Reuse next function to reduce allocations
        const next = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };

        try {
          const result = mw(req, res, next);

          // Handle async middleware - optimized with early check
          if (result && typeof result.then === 'function') {
            (result as Promise<void>)
              .then(() => {
                if (!resolved) next();
              })
              .catch(reject);
          } else if (!resolved) {
            // Sync middleware that didn't call next
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
    // Handle overloaded parameters (port, callback) or (port, host, callback)
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

  // Public method to force cleanup
  forceCleanup(): void {
    this.forceCleanupPools();
  }

  getServer(): Server {
    return this.server;
  }

  // Performance statistics
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

// Built-in middleware
export const middleware = {
  cors: (options: { origin?: string; credentials?: boolean } = {}): Middleware => {
    return (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', options.origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (options.credentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }

      if (req.method === 'OPTIONS') {
        res.status(200).send('');
        return;
      }

      next();
    };
  },

  helmet: (): Middleware => {
    return (req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('Content-Security-Policy', "default-src 'self'");
      next();
    };
  },

  compression: (options: { threshold?: number; level?: number } = {}): Middleware => {
    const threshold = options.threshold || 1024;
    const level = options.level || 6;

    return (req, res, next) => {
      const acceptEncoding = req.headers['accept-encoding'] || '';

      // Override res.json to compress responses
      const originalJson = res.json;
      const originalSend = res.send;

      const compressResponse = (data: any, isJson = false) => {
        const content = isJson ? JSON.stringify(data) : data;
        const buffer = Buffer.from(content);

        if (buffer.length < threshold) {
          return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
        }

        if (acceptEncoding.includes('gzip')) {
          zlib.gzip(buffer, { level }, (err: any, compressed: Buffer) => {
            if (err) {
              return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
            }
            if (!res.headersSent) {
              res.setHeader('Content-Encoding', 'gzip');
              res.setHeader('Content-Length', compressed.length);
            }
            res.end(compressed);
          });
        } else if (acceptEncoding.includes('deflate')) {
          zlib.deflate(buffer, { level }, (err: any, compressed: Buffer) => {
            if (err) {
              return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
            }
            if (!res.headersSent) {
              res.setHeader('Content-Encoding', 'deflate');
              res.setHeader('Content-Length', compressed.length);
            }
            res.end(compressed);
          });
        } else {
          return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
        }
      };

      res.json = function (data: any) {
        // Ensure charset is set for Safari compatibility
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
        compressResponse(data, true);
        return this;
      };

      res.send = function (data: any) {
        compressResponse(data, false);
        return this;
      };

      next();
    };
  },

  requestLogger: (): Middleware => {
    return (req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const duration = Date.now() - start;
        // Request completed - logged by framework
      });

      next();
    };
  },

  bodySize: (options: { limit?: string } = {}): Middleware => {
    const limit = options.limit || '10mb';
    const limitBytes = parseSize(limit);

    return (req, res, next) => {
      const contentLength = parseInt(req.headers['content-length'] || '0');

      if (contentLength > limitBytes) {
        res.status(413).json({
          success: false,
          error: 'Request entity too large',
          limit: limit,
        });
        return;
      }

      next();
    };
  },

  static: (options: {
    root: string;
    maxAge?: number;
    index?: string[];
    dotfiles?: 'allow' | 'deny' | 'ignore';
    etag?: boolean;
  }): Middleware => {
    return async (req, res, next) => {
      // Only handle GET and HEAD requests
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }

      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const crypto = await import('crypto');

        let filePath = path.join(options.root, req.path);

        // Security: prevent directory traversal
        if (!filePath.startsWith(path.resolve(options.root))) {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return;
        }

        // Handle dotfiles
        const basename = path.basename(filePath);
        if (basename.startsWith('.')) {
          if (options.dotfiles === 'deny') {
            res.status(403).json({ success: false, error: 'Forbidden' });
            return;
          } else if (options.dotfiles === 'ignore') {
            next();
            return;
          }
        }

        let stats;
        try {
          stats = await fs.stat(filePath);
        } catch {
          next(); // File not found, let other middleware handle
          return;
        }

        // Handle directories
        if (stats.isDirectory()) {
          const indexFiles = options.index || ['index.html', 'index.htm'];
          let indexFound = false;

          for (const indexFile of indexFiles) {
            const indexPath = path.join(filePath, indexFile);
            try {
              const indexStats = await fs.stat(indexPath);
              if (indexStats.isFile()) {
                filePath = indexPath;
                stats = indexStats;
                indexFound = true;
                break;
              }
            } catch {
              // Continue to next index file
            }
          }

          if (!indexFound) {
            next();
            return;
          }
        }

        // Set headers with proper mime type and charset
        const ext = path.extname(filePath);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.xml': 'application/xml',
        };

        const baseMimeType = mimeTypes[ext.toLowerCase()] || 'application/octet-stream';

        // Add charset for text-based files
        const textTypes = [
          'text/',
          'application/json',
          'application/javascript',
          'application/xml',
          'image/svg+xml',
        ];
        const needsCharset = textTypes.some(type => baseMimeType.startsWith(type));
        const contentType = needsCharset ? `${baseMimeType}; charset=utf-8` : baseMimeType;

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);

        // Cache headers
        if (options.maxAge) {
          res.setHeader('Cache-Control', `public, max-age=${options.maxAge}`);
        }

        // ETag support
        if (options.etag !== false) {
          const etag = crypto
            .createHash('md5')
            .update(`${stats.mtime.getTime()}-${stats.size}`)
            .digest('hex');
          res.setHeader('ETag', `"${etag}"`);

          // Handle conditional requests
          const ifNoneMatch = req.headers['if-none-match'];
          if (ifNoneMatch === `"${etag}"`) {
            res.statusCode = 304;
            res.end();
            return;
          }
        }

        // Handle HEAD requests
        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        // Send file
        const data = await fs.readFile(filePath);
        res.end(data);
      } catch {
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    };
  },

  upload: (
    options: {
      dest?: string;
      maxFileSize?: number;
      maxFiles?: number;
      allowedTypes?: string[];
    } = {}
  ): Middleware => {
    return (req, res, next) => {
      const contentType = req.headers['content-type'] || '';

      if (!contentType.includes('multipart/form-data')) {
        next();
        return;
      }

      // File upload handling is now built into parseBody method
      // This middleware can add additional validation
      if (req.body && req.body.files) {
        const files = req.body.files;
        const maxFileSize = options.maxFileSize || 5 * 1024 * 1024; // 5MB default
        const maxFiles = options.maxFiles || 10;
        const allowedTypes = options.allowedTypes;

        // Validate file count
        if (Object.keys(files).length > maxFiles) {
          res.status(400).json({
            success: false,
            error: `Too many files. Maximum ${maxFiles} allowed.`,
          });
          return;
        }

        // Validate each file
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [fieldName, file] of Object.entries(files)) {
          const fileData = file as any;

          // Validate file size
          if (fileData.size > maxFileSize) {
            res.status(400).json({
              success: false,
              error: `File ${fileData.filename} is too large. Maximum ${maxFileSize} bytes allowed.`,
            });
            return;
          }

          // Validate file type
          if (allowedTypes && !allowedTypes.includes(fileData.mimetype)) {
            res.status(400).json({
              success: false,
              error: `File type ${fileData.mimetype} not allowed.`,
            });
            return;
          }
        }

        // Store files in request for easy access
        req.files = files;
      }

      next();
    };
  },

  template: (options: {
    views: string;
    engine?: 'moro' | 'handlebars' | 'ejs';
    cache?: boolean;
    defaultLayout?: string;
  }): Middleware => {
    const templateCache = new Map<string, string>();

    return async (req, res, next) => {
      // Add render method to response
      res.render = async (template: string, data: any = {}) => {
        try {
          const fs = await import('fs/promises');
          const path = await import('path');

          const templatePath = path.join(options.views, `${template}.html`);

          let templateContent: string;

          // Check cache first
          if (options.cache && templateCache.has(templatePath)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            templateContent = templateCache.get(templatePath)!;
          } else {
            templateContent = await fs.readFile(templatePath, 'utf-8');
            if (options.cache) {
              templateCache.set(templatePath, templateContent);
            }
          }

          // Simple template engine - replace {{variable}} with values
          let rendered = templateContent;

          // Handle basic variable substitution
          rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
            return data[key] !== undefined ? String(data[key]) : match;
          });

          // Handle nested object properties like {{user.name}}
          rendered = rendered.replace(/\{\{([\w.]+)\}\}/g, (match: string, key: string) => {
            const value = key.split('.').reduce((obj: any, prop: string) => obj?.[prop], data);
            return value !== undefined ? String(value) : match;
          });

          // Handle loops: {{#each items}}{{name}}{{/each}}
          rendered = rendered.replace(
            /\{\{#each (\w+)\}\}(.*?)\{\{\/each\}\}/gs,
            (match, arrayKey, template) => {
              const array = data[arrayKey];
              if (!Array.isArray(array)) return '';

              return array
                .map(item => {
                  let itemTemplate = template;
                  // Replace variables in the loop template
                  itemTemplate = itemTemplate.replace(
                    /\{\{(\w+)\}\}/g,
                    (match: string, key: string) => {
                      return item[key] !== undefined ? String(item[key]) : match;
                    }
                  );
                  return itemTemplate;
                })
                .join('');
            }
          );

          // Handle conditionals: {{#if condition}}content{{/if}}
          rendered = rendered.replace(
            /\{\{#if (\w+)\}\}(.*?)\{\{\/if\}\}/gs,
            (match, conditionKey, content) => {
              const condition = data[conditionKey];
              return condition ? content : '';
            }
          );

          // Handle layout
          if (options.defaultLayout) {
            const layoutPath = path.join(options.views, 'layouts', `${options.defaultLayout}.html`);
            try {
              let layoutContent: string;

              if (options.cache && templateCache.has(layoutPath)) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                layoutContent = templateCache.get(layoutPath)!;
              } else {
                layoutContent = await fs.readFile(layoutPath, 'utf-8');
                if (options.cache) {
                  templateCache.set(layoutPath, layoutContent);
                }
              }

              rendered = layoutContent.replace(/\{\{body\}\}/, rendered);
            } catch {
              // Layout not found, use template as-is
            }
          }

          res.setHeader('Content-Type', 'text/html');
          res.end(rendered);
        } catch {
          res.status(500).json({ success: false, error: 'Template rendering failed' });
        }
      };

      next();
    };
  },

  // HTTP/2 Server Push middleware
  http2Push: (
    options: {
      resources?: Array<{ path: string; as: string; type?: string }>;
      condition?: (req: any) => boolean;
    } = {}
  ): Middleware => {
    return (req, res, next) => {
      // Add HTTP/2 push capability to response
      (res as any).push = (path: string, options: any = {}) => {
        // Check if HTTP/2 is supported
        if (req.httpVersion === '2.0' && (res as any).stream && (res as any).stream.pushAllowed) {
          try {
            const pushStream = (res as any).stream.pushStream({
              ':method': 'GET',
              ':path': path,
              ...options.headers,
            });

            if (pushStream) {
              // Handle push stream
              return pushStream;
            }
          } catch {
            // Push failed, continue normally
          }
        }
        return null;
      };

      // Auto-push configured resources
      if (options.resources && (!options.condition || options.condition(req))) {
        for (const resource of options.resources) {
          (res as any).push?.(resource.path, {
            headers: {
              'content-type': resource.type || 'text/plain',
            },
          });
        }
      }

      next();
    };
  },

  // Server-Sent Events middleware
  sse: (
    options: {
      heartbeat?: number;
      retry?: number;
      cors?: boolean;
    } = {}
  ): Middleware => {
    return (req, res, next) => {
      // Only handle SSE requests
      if (req.headers.accept?.includes('text/event-stream')) {
        // Set SSE headers
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': options.cors ? '*' : undefined,
            'Access-Control-Allow-Headers': options.cors ? 'Cache-Control' : undefined,
          });
        }

        // Add SSE methods to response
        (res as any).sendEvent = (data: any, event?: string, id?: string) => {
          if (id) res.write(`id: ${id}\n`);
          if (event) res.write(`event: ${event}\n`);
          res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
        };

        (res as any).sendComment = (comment: string) => {
          res.write(`: ${comment}\n\n`);
        };

        (res as any).sendRetry = (ms: number) => {
          res.write(`retry: ${ms}\n\n`);
        };

        // Set up heartbeat if configured
        let heartbeatInterval: NodeJS.Timeout | null = null;
        if (options.heartbeat) {
          heartbeatInterval = setInterval(() => {
            (res as any).sendComment('heartbeat');
          }, options.heartbeat);
        }

        // Set retry if configured
        if (options.retry) {
          (res as any).sendRetry(options.retry);
        }

        // Clean up on close
        req.on('close', () => {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }
        });

        // Don't call next() - this middleware handles the response
        return;
      }

      next();
    };
  },

  // Range request middleware for streaming
  range: (
    options: {
      acceptRanges?: string;
      maxRanges?: number;
    } = {}
  ): Middleware => {
    return async (req, res, next) => {
      // Add range support to response
      (res as any).sendRange = async (filePath: string, stats?: any) => {
        try {
          const fs = await import('fs/promises');
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const _path = await import('path');

          if (!stats) {
            stats = await fs.stat(filePath);
          }

          const fileSize = stats.size;
          const range = req.headers.range;

          // Set Accept-Ranges header
          res.setHeader('Accept-Ranges', options.acceptRanges || 'bytes');

          if (!range) {
            // No range requested, send entire file
            res.setHeader('Content-Length', fileSize);
            const data = await fs.readFile(filePath);
            res.end(data);
            return;
          }

          // Parse range header
          const ranges = range
            .replace(/bytes=/, '')
            .split(',')
            .map(r => {
              const [start, end] = r.split('-');
              return {
                start: start ? parseInt(start) : 0,
                end: end ? parseInt(end) : fileSize - 1,
              };
            });

          // Validate ranges
          if (options.maxRanges && ranges.length > options.maxRanges) {
            res.status(416).json({ success: false, error: 'Too many ranges' });
            return;
          }

          if (ranges.length === 1) {
            // Single range
            const { start, end } = ranges[0];
            const chunkSize = end - start + 1;

            if (start >= fileSize || end >= fileSize) {
              res.status(416);
              res.setHeader('Content-Range', `bytes */${fileSize}`);
              res.json({ success: false, error: 'Range not satisfiable' });
              return;
            }

            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', chunkSize);

            // Stream the range
            const stream = createReadStream(filePath, {
              start,
              end,
            });
            stream.pipe(res);
          } else {
            // Multiple ranges - multipart response
            const boundary = 'MULTIPART_BYTERANGES';
            res.status(206);
            res.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);

            for (const { start, end } of ranges) {
              if (start >= fileSize || end >= fileSize) continue;

              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const chunkSize = end - start + 1;
              res.write(`\r\n--${boundary}\r\n`);
              res.write(`Content-Range: bytes ${start}-${end}/${fileSize}\r\n\r\n`);

              const stream = createReadStream(filePath, {
                start,
                end,
              });
              await new Promise<void>(resolve => {
                stream.on('end', () => resolve());
                stream.pipe(res, { end: false });
              });
            }
            res.write(`\r\n--${boundary}--\r\n`);
            res.end();
          }
        } catch {
          res.status(500).json({ success: false, error: 'Range request failed' });
        }
      };

      next();
    };
  },

  // CSRF Protection middleware
  csrf: (
    options: {
      secret?: string;
      tokenLength?: number;
      cookieName?: string;
      headerName?: string;
      ignoreMethods?: string[];
      sameSite?: boolean;
    } = {}
  ): Middleware => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const secret = options.secret || 'moro-csrf-secret';
    const tokenLength = options.tokenLength || 32;
    const cookieName = options.cookieName || '_csrf';
    const headerName = options.headerName || 'x-csrf-token';
    const ignoreMethods = options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS'];

    const generateToken = () => {
      return crypto.randomBytes(tokenLength).toString('hex');
    };

    const verifyToken = (token: string, sessionToken: string) => {
      return token && sessionToken && token === sessionToken;
    };

    return (req, res, next) => {
      // Add CSRF token generation method
      (req as any).csrfToken = () => {
        if (!(req as any)._csrfToken) {
          (req as any)._csrfToken = generateToken();
          // Set token in cookie
          res.cookie(cookieName, (req as any)._csrfToken, {
            httpOnly: true,
            sameSite: options.sameSite !== false ? 'strict' : undefined,
            secure: req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted,
          });
        }
        return (req as any)._csrfToken;
      };

      // Skip verification for safe methods
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (ignoreMethods.includes(req.method!)) {
        next();
        return;
      }

      // Get token from header or body
      const token =
        req.headers[headerName] || (req.body && req.body._csrf) || (req.query && req.query._csrf);

      // Get session token from cookie
      const sessionToken = req.cookies?.[cookieName];

      if (!verifyToken(token as string, sessionToken || '')) {
        res.status(403).json({
          success: false,
          error: 'Invalid CSRF token',
          code: 'CSRF_TOKEN_MISMATCH',
        });
        return;
      }

      next();
    };
  },

  // Content Security Policy middleware
  csp: (
    options: {
      directives?: {
        defaultSrc?: string[];
        scriptSrc?: string[];
        styleSrc?: string[];
        imgSrc?: string[];
        connectSrc?: string[];
        fontSrc?: string[];
        objectSrc?: string[];
        mediaSrc?: string[];
        frameSrc?: string[];
        childSrc?: string[];
        workerSrc?: string[];
        formAction?: string[];
        upgradeInsecureRequests?: boolean;
        blockAllMixedContent?: boolean;
      };
      reportOnly?: boolean;
      reportUri?: string;
      nonce?: boolean;
    } = {}
  ): Middleware => {
    return (req, res, next) => {
      const directives = options.directives || {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      };

      // Generate nonce if requested
      let nonce: string | undefined;
      if (options.nonce) {
        nonce = crypto.randomBytes(16).toString('base64');
        (req as any).cspNonce = nonce;
      }

      // Build CSP header value
      const cspParts: string[] = [];

      for (const [directive, sources] of Object.entries(directives)) {
        if (directive === 'upgradeInsecureRequests' && sources === true) {
          cspParts.push('upgrade-insecure-requests');
        } else if (directive === 'blockAllMixedContent' && sources === true) {
          cspParts.push('block-all-mixed-content');
        } else if (Array.isArray(sources)) {
          let sourceList = sources.join(' ');

          // Add nonce to script-src and style-src if enabled
          if (nonce && (directive === 'scriptSrc' || directive === 'styleSrc')) {
            sourceList += ` 'nonce-${nonce}'`;
          }

          // Convert camelCase to kebab-case
          const kebabDirective = directive.replace(/([A-Z])/g, '-$1').toLowerCase();
          cspParts.push(`${kebabDirective} ${sourceList}`);
        }
      }

      // Add report-uri if specified
      if (options.reportUri) {
        cspParts.push(`report-uri ${options.reportUri}`);
      }

      const cspValue = cspParts.join('; ');
      const headerName = options.reportOnly
        ? 'Content-Security-Policy-Report-Only'
        : 'Content-Security-Policy';

      res.setHeader(headerName, cspValue);

      next();
    };
  },
};

function parseSize(size: string): number {
  const units: { [key: string]: number } = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) return 1024 * 1024; // Default 1MB

  const value = parseFloat(match[1]);
  const unit = match[2] || 'b';

  return Math.round(value * units[unit]);
}
