// src/core/http-server.ts
import { IncomingMessage, ServerResponse, createServer, Server } from 'http';
import { URL } from 'url';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { createFrameworkLogger } from '../logger';
import { HttpRequest, HttpResponse, HttpHandler, Middleware, RouteEntry } from '../../types/http';

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);

export class MoroHttpServer {
  private server: Server;
  private routes: RouteEntry[] = [];
  private globalMiddleware: Middleware[] = [];
  private compressionEnabled = true;
  private compressionThreshold = 1024;
  private logger = createFrameworkLogger('HttpServer');
  private hookManager: any;

  constructor() {
    this.server = createServer(this.handleRequest.bind(this));
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

    this.routes.push({
      method,
      path,
      pattern,
      paramNames,
      handler,
      middleware,
    });
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    // Convert parameterized routes to regex
    const regexPattern = path
      .replace(/\/:([^/]+)/g, (match, paramName) => {
        paramNames.push(paramName);
        return '/([^/]+)';
      })
      .replace(/\//g, '\\/');

    return {
      pattern: new RegExp(`^${regexPattern}$`),
      paramNames,
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const httpReq = this.enhanceRequest(req);
    const httpRes = this.enhanceResponse(res);

    try {
      // Parse URL and query parameters
      const url = new URL(req.url!, `http://${req.headers.host}`);
      httpReq.path = url.pathname;
      httpReq.query = Object.fromEntries(url.searchParams);

      // Parse body for POST/PUT/PATCH requests
      if (['POST', 'PUT', 'PATCH'].includes(req.method!)) {
        httpReq.body = await this.parseBody(req);
      }

      // Execute hooks before request processing
      if (this.hookManager) {
        await this.hookManager.execute('request', {
          request: httpReq,
          response: httpRes,
        });
      }

      // Execute global middleware first
      await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);

      // If middleware handled the request, don't continue
      if (httpRes.headersSent) {
        return;
      }

      // Find matching route
      const route = this.findRoute(req.method!, httpReq.path);
      if (!route) {
        httpRes.status(404).json({ success: false, error: 'Not found' });
        return;
      }

      // Extract path parameters
      const matches = httpReq.path.match(route.pattern);
      if (matches) {
        httpReq.params = {};
        route.paramNames.forEach((name, index) => {
          httpReq.params[name] = matches[index + 1];
        });
      }

      // Execute middleware chain
      await this.executeMiddleware(route.middleware, httpReq, httpRes);

      // Execute handler
      await route.handler(httpReq, httpRes);
    } catch (error) {
      // Debug: Log the actual error and where it came from
      console.log('🚨 MoroJS Request Error Details:');
      console.log('📍 Error type:', typeof error);
      console.log('📍 Error message:', error instanceof Error ? error.message : String(error));
      console.log('📍 Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      console.log('📍 Request path:', req.url);
      console.log('📍 Request method:', req.method);

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
          // Ultra-defensive fallback - check each method individually
          if (typeof httpRes.setHeader === 'function') {
            httpRes.statusCode = 500;
            httpRes.setHeader('Content-Type', 'application/json');
          } else {
            // Even setHeader doesn't exist - object is completely wrong
            console.error(
              '❌ Response object is not a proper ServerResponse:',
              typeof httpRes,
              Object.keys(httpRes)
            );
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
            console.error('❌ Cannot send error response - end() method missing');
          }
        }
      }
    }
  }

  private enhanceRequest(req: IncomingMessage): HttpRequest {
    const httpReq = req as HttpRequest;
    httpReq.params = {};
    httpReq.query = {};
    httpReq.body = null;
    httpReq.path = '';
    httpReq.ip = req.socket.remoteAddress || '';
    httpReq.requestId = Math.random().toString(36).substring(7);
    httpReq.headers = req.headers as Record<string, string>;

    // Parse cookies
    httpReq.cookies = this.parseCookies(req.headers.cookie || '');

    return httpReq;
  }

  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    });

    return cookies;
  }

  private enhanceResponse(res: ServerResponse): HttpResponse {
    const httpRes = res as HttpResponse;

    // BULLETPROOF status method - always works
    httpRes.status = (code: number) => {
      httpRes.statusCode = code;
      return httpRes;
    };

    httpRes.json = async (data: any) => {
      if (httpRes.headersSent) return;

      const jsonString = JSON.stringify(data);
      const buffer = Buffer.from(jsonString);

      httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');

      // Compression
      if (this.compressionEnabled && buffer.length > this.compressionThreshold) {
        const acceptEncoding = httpRes.req.headers['accept-encoding'] || '';

        if (acceptEncoding.includes('gzip')) {
          const compressed = await gzip(buffer);
          httpRes.setHeader('Content-Encoding', 'gzip');
          httpRes.setHeader('Content-Length', compressed.length);
          httpRes.end(compressed);
          return;
        } else if (acceptEncoding.includes('deflate')) {
          const compressed = await deflate(buffer);
          httpRes.setHeader('Content-Encoding', 'deflate');
          httpRes.setHeader('Content-Length', compressed.length);
          httpRes.end(compressed);
          return;
        }
      }

      httpRes.setHeader('Content-Length', buffer.length);
      httpRes.end(buffer);
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
      } catch (error) {
        httpRes.status(404).json({ success: false, error: 'File not found' });
      }
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
    // Add charset for text-based content types
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/xml',
      'image/svg+xml',
    ];

    const needsCharset = textTypes.some(type => mimeType.startsWith(type));

    if (needsCharset && !mimeType.includes('charset')) {
      return `${mimeType}; charset=utf-8`;
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

    for (let i = 1; i < parts.length - 1; i++) {
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

  private findRoute(method: string, path: string): RouteEntry | null {
    return this.routes.find(route => route.method === method && route.pattern.test(path)) || null;
  }

  private async executeMiddleware(
    middleware: Middleware[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    for (const mw of middleware) {
      await new Promise<void>((resolve, reject) => {
        let nextCalled = false;

        const next = () => {
          if (nextCalled) return;
          nextCalled = true;
          resolve();
        };

        try {
          const result = mw(req, res, next);

          // Handle async middleware
          if (result instanceof Promise) {
            result
              .then(() => {
                if (!nextCalled) next();
              })
              .catch(reject);
          }
        } catch (error) {
          reject(error);
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

  getServer(): Server {
    return this.server;
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
    const zlib = require('zlib');
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
          res.setHeader('Content-Encoding', 'gzip');
          zlib.gzip(buffer, { level }, (err: any, compressed: Buffer) => {
            if (err) {
              return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
            }
            res.setHeader('Content-Length', compressed.length);
            res.writeHead(res.statusCode || 200, res.getHeaders());
            res.end(compressed);
          });
        } else if (acceptEncoding.includes('deflate')) {
          res.setHeader('Content-Encoding', 'deflate');
          zlib.deflate(buffer, { level }, (err: any, compressed: Buffer) => {
            if (err) {
              return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
            }
            res.setHeader('Content-Length', compressed.length);
            res.writeHead(res.statusCode || 200, res.getHeaders());
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
        } catch (error) {
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
            } catch (error) {
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
      } catch (error) {
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
                layoutContent = templateCache.get(layoutPath)!;
              } else {
                layoutContent = await fs.readFile(layoutPath, 'utf-8');
                if (options.cache) {
                  templateCache.set(layoutPath, layoutContent);
                }
              }

              rendered = layoutContent.replace(/\{\{body\}\}/, rendered);
            } catch (error) {
              // Layout not found, use template as-is
            }
          }

          res.setHeader('Content-Type', 'text/html');
          res.end(rendered);
        } catch (error) {
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
          } catch (error) {
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
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': options.cors ? '*' : undefined,
          'Access-Control-Allow-Headers': options.cors ? 'Cache-Control' : undefined,
        });

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
          const path = await import('path');

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
              res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
              res.json({ success: false, error: 'Range not satisfiable' });
              return;
            }

            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', chunkSize);

            // Stream the range
            const stream = require('fs').createReadStream(filePath, {
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

              const chunkSize = end - start + 1;
              res.write(`\r\n--${boundary}\r\n`);
              res.write(`Content-Range: bytes ${start}-${end}/${fileSize}\r\n\r\n`);

              const stream = require('fs').createReadStream(filePath, {
                start,
                end,
              });
              await new Promise(resolve => {
                stream.on('end', resolve);
                stream.pipe(res, { end: false });
              });
            }
            res.write(`\r\n--${boundary}--\r\n`);
            res.end();
          }
        } catch (error) {
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
    const secret = options.secret || 'moro-csrf-secret';
    const tokenLength = options.tokenLength || 32;
    const cookieName = options.cookieName || '_csrf';
    const headerName = options.headerName || 'x-csrf-token';
    const ignoreMethods = options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS'];

    const generateToken = () => {
      const crypto = require('crypto');
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
        const crypto = require('crypto');
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
