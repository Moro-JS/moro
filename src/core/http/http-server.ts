// src/core/http-server.ts
import { IncomingMessage, ServerResponse, createServer, Server } from 'http';
import * as zlib from 'zlib';
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
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;
  private requestDecorations: Record<string, any> = {};
  private responseDecorations: Record<string, any> = {};

  // Body size limits - defaults overridden by config in constructor
  private maxBodySize: number = 10 * 1024 * 1024; // Default 10MB (overridden by server.bodySizeLimit config)
  private maxUploadSize: number = 100 * 1024 * 1024; // Default 100MB for file uploads (future: configurable)

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

  constructor(options?: { maxBodySize?: number; maxUploadSize?: number }) {
    this.server = createServer(this.handleRequest.bind(this));

    // Configure body size limits from options
    if (options?.maxBodySize) {
      this.maxBodySize = options.maxBodySize;
    }
    if (options?.maxUploadSize) {
      this.maxUploadSize = options.maxUploadSize;
    }

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

  // Register a global error handler (called from Moro.setErrorHandler)
  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): void {
    this.errorHandler = fn;
  }

  // Apply per-request/response decoration maps (called from Moro.decorateRequest/Reply)
  setRequestDecorations(decorations: Record<string, any>): void {
    this.requestDecorations = decorations;
  }

  setResponseDecorations(decorations: Record<string, any>): void {
    this.responseDecorations = decorations;
  }

  // Middleware management
  use(middleware: Middleware): void {
    // Defensive check: Don't add MiddlewareInterface objects to globalMiddleware
    // MiddlewareInterface objects should only be handled by MiddlewareManager
    if (
      middleware &&
      typeof middleware === 'object' &&
      (middleware as any).install &&
      (middleware as any).metadata
    ) {
      this.logger?.warn?.(
        `Attempted to add MiddlewareInterface "${(middleware as any).metadata?.name}" to HTTP server globalMiddleware. ` +
          `This should be handled by MiddlewareManager instead. Skipping.`,
        'Middleware'
      );
      return;
    }

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

      // User-registered global error handler takes precedence over the default 500.
      if (this.errorHandler && !httpRes.headersSent) {
        try {
          const handlerResult = this.errorHandler(error, httpReq, httpRes);
          if (handlerResult && typeof (handlerResult as any).then === 'function') {
            await handlerResult;
          }
          if (httpRes.headersSent) return;
        } catch (handlerErr) {
          this.logger.error('Error handler itself threw', 'RequestHandler', {
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        }
      }

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
      // Always release pooled objects back to the pool
      // This prevents memory leaks and ensures consistent performance
      // Check if object is empty without Object.keys()
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
      // Check if object is empty without Object.keys()
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

    // Stream large JSON responses to prevent memory issues
    if (Array.isArray(data) && data.length > 100) {
      // Stream large arrays element by element
      res.write('[');

      // Stream each array element
      let first = true;
      for (const item of data) {
        if (!first) res.write(',');
        res.write(JSON.stringify(item));
        first = false;
      }

      // Write closing bracket and end
      res.end(']');
    } else if (typeof data === 'object' && data !== null && Object.keys(data).length > 50) {
      // For large objects, stream key-value pairs
      res.write('{');
      const keys = Object.keys(data);
      let first = true;

      for (const key of keys) {
        if (!first) res.write(',');
        // Properly escape the key using JSON.stringify
        res.write(`${JSON.stringify(key)}:${JSON.stringify(data[key])}`);
        first = false;
      }

      res.end('}');
    } else {
      // For smaller data, still avoid the old chunking approach
      const jsonString = JSON.stringify(data);
      res.end(jsonString);
    }
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

    // Per-request typed context bag
    httpReq.context = {};

    // Apply user-registered request decorations
    for (const key in this.requestDecorations) {
      (httpReq as any)[key] = this.requestDecorations[key];
    }

    // Express-compatible request helpers
    httpReq.get = httpReq.header = (name: string): string | undefined => {
      const lower = name.toLowerCase();
      if (lower === 'referer' || lower === 'referrer') {
        return (httpReq.headers.referer || httpReq.headers.referrer) as string | undefined;
      }
      const v = httpReq.headers[lower];
      return Array.isArray(v) ? v[0] : v;
    };

    httpReq.is = (type: string): boolean => {
      const ct = (httpReq.headers['content-type'] || '') as string;
      if (!ct) return false;
      const mime = ct.split(';')[0].trim().toLowerCase();
      const t = type.toLowerCase();
      if (t.indexOf('/') === -1) {
        // e.g. 'json' → match */json or +json suffix
        return mime.endsWith(`/${t}`) || mime.endsWith(`+${t}`);
      }
      if (t.endsWith('/*')) {
        return mime.startsWith(t.slice(0, -1));
      }
      return mime === t;
    };

    httpReq.accepts = (types?: string | string[]): string | false => {
      const accept = (httpReq.headers.accept || '*/*') as string;
      if (!types) return accept;
      const wanted = Array.isArray(types) ? types : [types];
      if (accept === '*/*' || accept === '') return wanted[0] || false;
      const acceptTypes = accept.split(',').map(s => s.split(';')[0].trim().toLowerCase());
      for (const w of wanted) {
        const wl = w.toLowerCase();
        const wMime = wl.indexOf('/') === -1 ? `application/${wl}` : wl;
        for (const at of acceptTypes) {
          if (at === '*/*') return w;
          if (at === wMime) return w;
          if (at.endsWith('/*') && wMime.startsWith(at.slice(0, -1))) return w;
        }
      }
      return false;
    };

    httpReq.acceptsLanguages = (langs?: string | string[]): string | false => {
      const acceptLang = (httpReq.headers['accept-language'] || '') as string;
      if (!langs) return acceptLang || false;
      const wanted = Array.isArray(langs) ? langs : [langs];
      if (!acceptLang) return wanted[0] || false;
      // Parse with q values; sort by q desc to match Express's "best match wins"
      const accepted = acceptLang
        .split(',')
        .map(s => {
          const parts = s.trim().split(';');
          const tag = parts[0].toLowerCase();
          const qPart = parts.find(p => p.trim().startsWith('q='));
          const q = qPart ? parseFloat(qPart.trim().slice(2)) : 1;
          return { tag, q: isNaN(q) ? 0 : q };
        })
        .filter(a => a.q > 0)
        .sort((a, b) => b.q - a.q);
      for (const { tag } of accepted) {
        for (const w of wanted) {
          const wl = w.toLowerCase();
          if (tag === '*' || tag === wl || tag.split('-')[0] === wl.split('-')[0]) return w;
        }
      }
      return false;
    };

    const host = (httpReq.headers.host || '') as string;
    httpReq.hostname = host ? host.split(':')[0] : '';
    const forwardedProto = httpReq.headers['x-forwarded-proto'] as string | undefined;
    httpReq.protocol = forwardedProto
      ? forwardedProto.split(',')[0].trim()
      : (req.socket as any).encrypted
        ? 'https'
        : 'http';
    httpReq.secure = httpReq.protocol === 'https';
    const xrw = httpReq.headers['x-requested-with'] as string | undefined;
    httpReq.xhr = !!xrw && xrw.toLowerCase() === 'xmlhttprequest';

    httpReq.originalUrl = req.url || '';

    const forwardedFor = httpReq.headers['x-forwarded-for'] as string | undefined;
    httpReq.ips = forwardedFor
      ? forwardedFor
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];

    const hostnameParts = httpReq.hostname.split('.');
    // Matches Express: subdomains are parts before the last two (domain + tld),
    // reversed (closest subdomain first).
    httpReq.subdomains = hostnameParts.length > 2 ? hostnameParts.slice(0, -2).reverse() : [];

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

      // Simple, optimized JSON serialization - let V8 handle the optimization
      const jsonString = JSON.stringify(data);

      // Large response check - stream if needed
      if (jsonString.length > 32768) {
        // Large response - stream it
        return this.streamLargeResponse(httpRes, data);
      }

      // Use efficient buffer allocation - let Node.js handle optimization
      const finalBuffer = Buffer.from(jsonString, 'utf8');

      // Optimized header setting - set multiple headers at once when possible
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json; charset=utf-8',
      };

      // Compression with buffer pool - EARLY EXIT if disabled or below threshold
      // Only make this async if compression is actually happening
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
          });
          return;
        }
      }

      // SYNC PATH - no compression, fast path
      headers['Content-Length'] = finalBuffer.length;

      // Batch write all headers at once
      httpRes.writeHead(httpRes.statusCode || 200, headers);

      httpRes.end(finalBuffer);
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
      // Avoid spread operator - direct array manipulation
      const cookies = Array.isArray(existingCookies)
        ? existingCookies
        : [existingCookies as string];
      cookies.push(cookieString);
      httpRes.setHeader('Set-Cookie', cookies);

      return httpRes;
    };

    httpRes.clearCookie = (name: string, options: any = {}) => {
      // Avoid spread operator - manually set properties
      const clearOptions: any = {
        expires: new Date(0),
        maxAge: 0,
      };
      // Copy other options manually
      if (options.path !== undefined) clearOptions.path = options.path;
      if (options.domain !== undefined) clearOptions.domain = options.domain;
      if (options.httpOnly !== undefined) clearOptions.httpOnly = options.httpOnly;
      if (options.secure !== undefined) clearOptions.secure = options.secure;
      if (options.sameSite !== undefined) clearOptions.sameSite = options.sameSite;
      return httpRes.cookie(name, '', clearOptions);
    };

    httpRes.redirect = (url: string, status: number = 302) => {
      if (httpRes.headersSent) return;
      httpRes.statusCode = status;
      const safeUrl = url.replace(/[\r\n]/g, '');
      httpRes.setHeader('Location', safeUrl);
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

    // Header management utilities
    httpRes.hasHeader = (name: string): boolean => {
      return httpRes.getHeader(name) !== undefined;
    };

    // Note: removeHeader is inherited from ServerResponse, we don't override it

    httpRes.setBulkHeaders = (headers: Record<string, string | number>) => {
      if (httpRes.headersSent) {
        // Only enumerate keys for warning if headers were already sent
        const attemptedHeaderKeys = [];
        for (const key in headers) {
          attemptedHeaderKeys.push(key);
        }
        this.logger.warn('Cannot set headers - headers already sent', 'HeaderWarning', {
          attemptedHeaders: attemptedHeaderKeys,
        });
        return httpRes;
      }

      for (const key in headers) {
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

    // Per-response typed state bag (Express-compatible)
    httpRes.locals = {};

    // Apply user-registered response decorations
    for (const key in this.responseDecorations) {
      (httpRes as any)[key] = this.responseDecorations[key];
    }

    // Express-compatible response helpers
    httpRes.set = (
      field: string | Record<string, string | string[] | number>,
      value?: string | string[] | number
    ) => {
      if (httpRes.headersSent) return httpRes;
      if (typeof field === 'string') {
        if (value !== undefined) {
          httpRes.setHeader(field, value as any);
        }
      } else {
        for (const key in field) {
          httpRes.setHeader(key, field[key] as any);
        }
      }
      return httpRes;
    };

    httpRes.get = (field: string) => {
      return httpRes.getHeader(field) as any;
    };

    httpRes.append = (field: string, value: string | string[]) => {
      return httpRes.appendHeader(field, value);
    };

    httpRes.type = (contentType: string) => {
      if (httpRes.headersSent) return httpRes;
      // If no "/" treat as shorthand (e.g. "json" → "application/json")
      let ct = contentType;
      if (ct.indexOf('/') === -1) {
        const shorthands: Record<string, string> = {
          json: 'application/json; charset=utf-8',
          html: 'text/html; charset=utf-8',
          text: 'text/plain; charset=utf-8',
          txt: 'text/plain; charset=utf-8',
          xml: 'application/xml',
          js: 'application/javascript',
          css: 'text/css; charset=utf-8',
          form: 'application/x-www-form-urlencoded',
        };
        ct = shorthands[ct.toLowerCase()] || `application/${ct}`;
      }
      httpRes.setHeader('Content-Type', ct);
      return httpRes;
    };

    httpRes.sendStatus = (code: number) => {
      if (httpRes.headersSent) return;
      httpRes.statusCode = code;
      const messages: Record<number, string> = {
        200: 'OK',
        201: 'Created',
        202: 'Accepted',
        204: 'No Content',
        301: 'Moved Permanently',
        302: 'Found',
        304: 'Not Modified',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        409: 'Conflict',
        410: 'Gone',
        422: 'Unprocessable Entity',
        429: 'Too Many Requests',
        500: 'Internal Server Error',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
      };
      const body = messages[code] || String(code);
      httpRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
      httpRes.end(body);
    };

    httpRes.location = (url: string) => {
      if (httpRes.headersSent) return httpRes;
      const safe = url.replace(/[\r\n]/g, '');
      httpRes.setHeader('Location', safe);
      return httpRes;
    };

    httpRes.vary = (field: string | string[]) => {
      if (httpRes.headersSent) return httpRes;
      const existing = httpRes.getHeader('Vary');
      const existingList = existing
        ? String(existing)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [];
      const incoming = Array.isArray(field) ? field : [field];
      for (const f of incoming) {
        if (!existingList.some(e => e.toLowerCase() === f.toLowerCase())) {
          existingList.push(f);
        }
      }
      httpRes.setHeader('Vary', existingList.join(', '));
      return httpRes;
    };

    httpRes.attachment = (filename?: string) => {
      if (httpRes.headersSent) return httpRes;
      if (filename) {
        const safeName = filename.replace(/[\r\n"]/g, '');
        httpRes.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        // Set Content-Type from extension if not already set
        if (!httpRes.getHeader('Content-Type')) {
          // fire-and-forget mime lookup; not awaited to keep signature chainable
          this.getMimeType(filename.substring(filename.lastIndexOf('.'))).then(mime => {
            if (!httpRes.getHeader('Content-Type') && !httpRes.headersSent) {
              httpRes.setHeader('Content-Type', mime);
            }
          });
        }
      } else {
        httpRes.setHeader('Content-Disposition', 'attachment');
      }
      return httpRes;
    };

    httpRes.download = async (filePath: string, filename?: string) => {
      httpRes.attachment(filename || filePath.split('/').pop());
      return httpRes.sendFile(filePath);
    };

    httpRes.format = (handlers: Record<string, () => any | Promise<any>>) => {
      const types = Object.keys(handlers).filter(k => k !== 'default');
      const matched = req.accepts(types);
      const chosen = matched ? handlers[matched as string] : handlers.default;
      if (!chosen) {
        httpRes.statusCode = 406;
        httpRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
        httpRes.end('Not Acceptable');
        return;
      }
      httpRes.vary('Accept');
      if (matched && typeof matched === 'string') {
        httpRes.type(matched);
      }
      chosen();
    };

    httpRes.links = (links: Record<string, string>) => {
      if (httpRes.headersSent) return httpRes;
      const parts: string[] = [];
      for (const rel in links) {
        parts.push(`<${links[rel]}>; rel="${rel}"`);
      }
      if (parts.length > 0) {
        const existing = httpRes.getHeader('Link');
        const combined = existing ? `${existing}, ${parts.join(', ')}` : parts.join(', ');
        httpRes.setHeader('Link', combined);
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
    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0');

    // Use different limits based on content type
    // Multipart (file uploads) need much larger limits than JSON/form data
    const isMultipart = contentType.includes('multipart/form-data');
    const maxSize = isMultipart
      ? this.maxUploadSize // Configurable file upload limit (default 100MB)
      : this.maxBodySize; // Configurable body size limit (default 10MB, from server.bodySizeLimit config)

    // For very large payloads, return a streaming interface instead of buffering
    if (contentLength > maxSize / 2) {
      // Stream for payloads > 50MB (uploads) or > 5MB (JSON/form)
      return this.createStreamingBodyParser(req, contentType, maxSize);
    }

    // Standard buffered parsing for smaller payloads
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLength = 0;

      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          const errorMessage = isMultipart
            ? `File upload too large. Maximum ${Math.floor(maxSize / (1024 * 1024))}MB allowed.`
            : 'Request body too large';
          reject(new Error(errorMessage));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks);

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

  /**
   * Create a streaming body parser for large payloads
   * Returns a streaming interface instead of buffering
   */
  private createStreamingBodyParser(
    req: IncomingMessage,
    contentType: string,
    maxSize: number
  ): any {
    let totalLength = 0;
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      const streamParser = {
        // Streaming JSON parser for large JSON payloads
        json: () => this.streamJsonParse(req, maxSize),

        // Streaming form data parser
        form: () => this.streamFormParse(req, maxSize),

        // Raw stream access
        stream: () => ({
          onData: (callback: (chunk: Buffer) => void) => {
            req.on('data', (chunk: Buffer) => {
              totalLength += chunk.length;
              if (totalLength > maxSize) {
                reject(new Error('Request body too large'));
                return;
              }
              callback(chunk);
            });
          },
          onEnd: (callback: () => void) => {
            req.on('end', callback);
          },
          onError: (callback: (error: Error) => void) => {
            req.on('error', callback);
          },
        }),

        // Traditional buffered parsing (fallback)
        buffer: async () => {
          return new Promise((resolveBuffer, rejectBuffer) => {
            req.on('data', (chunk: Buffer) => {
              totalLength += chunk.length;
              if (totalLength > maxSize) {
                rejectBuffer(new Error('Request body too large'));
                return;
              }
              chunks.push(chunk);
            });

            req.on('end', () => {
              try {
                const body = Buffer.concat(chunks);
                if (contentType.includes('application/json')) {
                  resolveBuffer(JSON.parse(body.toString()));
                } else {
                  resolveBuffer(body.toString());
                }
              } catch (error) {
                rejectBuffer(error);
              }
            });

            req.on('error', rejectBuffer);
          });
        },
      };

      // Auto-detect and return appropriate parser
      if (contentType.includes('application/json')) {
        resolve({ type: 'json', parser: streamParser.json });
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        resolve({ type: 'form', parser: streamParser.form });
      } else {
        resolve({ type: 'stream', parser: streamParser.stream });
      }
    });
  }

  /**
   * Streaming JSON parser for large payloads
   */
  private async streamJsonParse(req: IncomingMessage, maxSize: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let jsonString = '';
      let totalLength = 0;

      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        jsonString += chunk.toString();
      });

      req.on('end', () => {
        try {
          // For very large JSON, consider streaming JSON parsing in the future
          resolve(JSON.parse(jsonString));
        } catch (error) {
          reject(error);
        }
      });

      req.on('error', reject);
    });
  }

  /**
   * Streaming form data parser
   */
  private async streamFormParse(req: IncomingMessage, maxSize: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let formData = '';
      let totalLength = 0;

      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length;
        if (totalLength > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        formData += chunk.toString();
      });

      req.on('end', () => {
        try {
          resolve(this.parseUrlEncoded(formData));
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

    // Work with Buffer directly - don't convert to string (corrupts binary data)
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const parts = this.splitBuffer(buffer, boundaryBuffer);
    const fields: Record<string, string> = {};
    const files: Record<string, any> = {};

    // Skip first (empty) and last (closing boundary) parts
    const partsLen = parts.length - 1;
    for (let i = 1; i < partsLen; i++) {
      const part = parts[i];

      // Find the double CRLF that separates headers from content
      const headerEndPos = this.findBufferSequence(part, Buffer.from('\r\n\r\n'));
      if (headerEndPos === -1) continue;

      // Headers are always text - safe to convert to string
      const headers = part.slice(0, headerEndPos).toString('utf8');
      // Content stays as Buffer to preserve binary data
      const content = part.slice(headerEndPos + 4); // Skip the \r\n\r\n

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type: ([^\r\n]+)/);

      if (nameMatch) {
        const name = nameMatch[1];

        if (filenameMatch) {
          // This is a file - keep as Buffer to preserve binary data
          const filename = filenameMatch[1];
          const mimeType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';

          // Remove trailing \r\n (2 bytes) from the end
          const fileData = content.slice(0, content.length - 2);

          files[name] = {
            filename,
            mimetype: mimeType,
            data: fileData, // Already a Buffer - preserves binary integrity
            size: fileData.length,
          };
        } else {
          // This is a regular field - convert to string
          const fieldContent = content.slice(0, content.length - 2); // Remove trailing \r\n
          fields[name] = fieldContent.toString('utf8');
        }
      }
    }

    return { fields, files };
  }

  /**
   * Split a Buffer by a delimiter Buffer
   * Used for multipart boundary splitting without corrupting binary data
   */
  private splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
    const parts: Buffer[] = [];
    let start = 0;
    let pos = 0;

    while ((pos = buffer.indexOf(delimiter, start)) !== -1) {
      parts.push(buffer.slice(start, pos));
      start = pos + delimiter.length;
    }

    // Add the remaining part
    parts.push(buffer.slice(start));

    return parts;
  }

  /**
   * Find the position of a sequence within a Buffer
   * Returns -1 if not found
   */
  private findBufferSequence(buffer: Buffer, sequence: Buffer): number {
    return buffer.indexOf(sequence);
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

    // O(1) static route lookup
    const staticRoute = this.staticRoutes.get(normalizedCacheKey);
    if (staticRoute) {
      this.routeCache.set(normalizedCacheKey, staticRoute);
      if (normalizedPath !== path) {
        this.routeCache.set(cacheKey, staticRoute);
      }
      return staticRoute;
    }

    // Dynamic route matching by segment count
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

  // Middleware execution with Express-compatible error propagation.
  // Supports: 3-arg (req, res, next), 4-arg (err, req, res, next) error middlewares,
  // and next(err) to skip forward to the next error middleware.
  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    const len = middleware.length;
    let activeError: any = undefined;

    for (let i = 0; i < len; i++) {
      if (res.headersSent) return;

      const mw = middleware[i] as any;
      const isErrorHandler = mw.length >= 4;

      // Non-error middleware is skipped while an error is active; error middleware
      // is skipped while no error is active. Matches Express semantics.
      if (activeError !== undefined && !isErrorHandler) continue;
      if (activeError === undefined && isErrorHandler) continue;

      activeError = await new Promise<any>(resolve => {
        let resolved = false;

        const next = (err?: any) => {
          if (resolved) return;
          resolved = true;
          resolve(err);
        };

        try {
          const result = isErrorHandler ? mw(activeError, req, res, next) : mw(req, res, next);

          if (result && typeof (result as any).then === 'function') {
            (result as Promise<void>)
              .then(() => {
                if (!resolved) next();
              })
              .catch((err: any) => {
                if (!resolved) next(err);
              });
          } else if (!resolved) {
            next();
          }
        } catch (err) {
          if (!resolved) next(err);
        }
      });
    }

    // If an error is still unhandled after the chain, re-throw so the top-level
    // catch in handleRequest can invoke the registered errorHandler / default 500.
    if (activeError !== undefined) {
      throw activeError;
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
