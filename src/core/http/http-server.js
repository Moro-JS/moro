"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.middleware = exports.MoroHttpServer = void 0;
// src/core/http-server.ts
const http_1 = require("http");
const url_1 = require("url");
const zlib = __importStar(require("zlib"));
const util_1 = require("util");
const logger_1 = require("../logger");
const gzip = (0, util_1.promisify)(zlib.gzip);
const deflate = (0, util_1.promisify)(zlib.deflate);
class MoroHttpServer {
    server;
    routes = [];
    globalMiddleware = [];
    compressionEnabled = true;
    compressionThreshold = 1024;
    logger = (0, logger_1.createFrameworkLogger)('HttpServer');
    constructor() {
        this.server = (0, http_1.createServer)(this.handleRequest.bind(this));
    }
    // Middleware management
    use(middleware) {
        this.globalMiddleware.push(middleware);
    }
    // Routing methods
    get(path, ...handlers) {
        this.addRoute('GET', path, handlers);
    }
    post(path, ...handlers) {
        this.addRoute('POST', path, handlers);
    }
    put(path, ...handlers) {
        this.addRoute('PUT', path, handlers);
    }
    delete(path, ...handlers) {
        this.addRoute('DELETE', path, handlers);
    }
    patch(path, ...handlers) {
        this.addRoute('PATCH', path, handlers);
    }
    addRoute(method, path, handlers) {
        const { pattern, paramNames } = this.pathToRegex(path);
        const handler = handlers.pop();
        const middleware = handlers;
        this.routes.push({
            method,
            path,
            pattern,
            paramNames,
            handler,
            middleware,
        });
    }
    pathToRegex(path) {
        const paramNames = [];
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
    async handleRequest(req, res) {
        const httpReq = this.enhanceRequest(req);
        const httpRes = this.enhanceResponse(res);
        try {
            // Parse URL and query parameters
            const url = new url_1.URL(req.url, `http://${req.headers.host}`);
            httpReq.path = url.pathname;
            httpReq.query = Object.fromEntries(url.searchParams);
            // Parse body for POST/PUT/PATCH requests
            if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
                httpReq.body = await this.parseBody(req);
            }
            // Execute global middleware first
            await this.executeMiddleware(this.globalMiddleware, httpReq, httpRes);
            // If middleware handled the request, don't continue
            if (httpRes.headersSent) {
                return;
            }
            // Find matching route
            const route = this.findRoute(req.method, httpReq.path);
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
        }
        catch (error) {
            this.logger.error('Request error', 'RequestHandler', {
                error: error instanceof Error ? error.message : String(error),
                requestId: httpReq.requestId,
                method: req.method,
                path: req.url,
            });
            if (!httpRes.headersSent) {
                httpRes.status(500).json({
                    success: false,
                    error: 'Internal server error',
                    requestId: httpReq.requestId,
                });
            }
        }
    }
    enhanceRequest(req) {
        const httpReq = req;
        httpReq.params = {};
        httpReq.query = {};
        httpReq.body = null;
        httpReq.path = '';
        httpReq.ip = req.socket.remoteAddress || '';
        httpReq.requestId = Math.random().toString(36).substring(7);
        httpReq.headers = req.headers;
        // Parse cookies
        httpReq.cookies = this.parseCookies(req.headers.cookie || '');
        return httpReq;
    }
    parseCookies(cookieHeader) {
        const cookies = {};
        if (!cookieHeader)
            return cookies;
        cookieHeader.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            if (name && value) {
                cookies[name] = decodeURIComponent(value);
            }
        });
        return cookies;
    }
    enhanceResponse(res) {
        const httpRes = res;
        httpRes.json = async (data) => {
            if (httpRes.headersSent)
                return;
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
                }
                else if (acceptEncoding.includes('deflate')) {
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
        httpRes.status = (code) => {
            httpRes.statusCode = code;
            return httpRes;
        };
        httpRes.send = (data) => {
            if (httpRes.headersSent)
                return;
            // Auto-detect content type if not already set
            if (!httpRes.getHeader('Content-Type')) {
                if (typeof data === 'string') {
                    // Check if it's JSON
                    try {
                        JSON.parse(data);
                        httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
                    }
                    catch {
                        // Default to plain text
                        httpRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    }
                }
                else {
                    // Buffer data - default to octet-stream
                    httpRes.setHeader('Content-Type', 'application/octet-stream');
                }
            }
            httpRes.end(data);
        };
        httpRes.cookie = (name, value, options = {}) => {
            const cookieValue = encodeURIComponent(value);
            let cookieString = `${name}=${cookieValue}`;
            if (options.maxAge)
                cookieString += `; Max-Age=${options.maxAge}`;
            if (options.expires)
                cookieString += `; Expires=${options.expires.toUTCString()}`;
            if (options.httpOnly)
                cookieString += '; HttpOnly';
            if (options.secure)
                cookieString += '; Secure';
            if (options.sameSite)
                cookieString += `; SameSite=${options.sameSite}`;
            if (options.domain)
                cookieString += `; Domain=${options.domain}`;
            if (options.path)
                cookieString += `; Path=${options.path}`;
            const existingCookies = httpRes.getHeader('Set-Cookie') || [];
            const cookies = Array.isArray(existingCookies)
                ? [...existingCookies]
                : [existingCookies];
            cookies.push(cookieString);
            httpRes.setHeader('Set-Cookie', cookies);
            return httpRes;
        };
        httpRes.clearCookie = (name, options = {}) => {
            const clearOptions = { ...options, expires: new Date(0), maxAge: 0 };
            return httpRes.cookie(name, '', clearOptions);
        };
        httpRes.redirect = (url, status = 302) => {
            if (httpRes.headersSent)
                return;
            httpRes.statusCode = status;
            httpRes.setHeader('Location', url);
            httpRes.end();
        };
        httpRes.sendFile = async (filePath) => {
            if (httpRes.headersSent)
                return;
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
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
            }
            catch (error) {
                httpRes.status(404).json({ success: false, error: 'File not found' });
            }
        };
        return httpRes;
    }
    async getMimeType(ext) {
        const mimeTypes = {
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
    addCharsetIfNeeded(mimeType) {
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
    async parseBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalLength = 0;
            const maxSize = 10 * 1024 * 1024; // 10MB limit
            req.on('data', (chunk) => {
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
                    }
                    else if (contentType.includes('application/x-www-form-urlencoded')) {
                        resolve(this.parseUrlEncoded(body.toString()));
                    }
                    else if (contentType.includes('multipart/form-data')) {
                        resolve(this.parseMultipart(body, contentType));
                    }
                    else {
                        resolve(body.toString());
                    }
                }
                catch (error) {
                    reject(error);
                }
            });
            req.on('error', reject);
        });
    }
    parseMultipart(buffer, contentType) {
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
            throw new Error('Invalid multipart boundary');
        }
        const parts = buffer.toString('binary').split('--' + boundary);
        const fields = {};
        const files = {};
        for (let i = 1; i < parts.length - 1; i++) {
            const part = parts[i];
            const [headers, content] = part.split('\r\n\r\n');
            if (!headers || content === undefined)
                continue;
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
                }
                else {
                    // This is a regular field
                    fields[name] = content.substring(0, content.length - 2); // Remove trailing \r\n
                }
            }
        }
        return { fields, files };
    }
    parseUrlEncoded(body) {
        const params = new URLSearchParams(body);
        const result = {};
        for (const [key, value] of params) {
            result[key] = value;
        }
        return result;
    }
    findRoute(method, path) {
        return this.routes.find(route => route.method === method && route.pattern.test(path)) || null;
    }
    async executeMiddleware(middleware, req, res) {
        for (const mw of middleware) {
            await new Promise((resolve, reject) => {
                let nextCalled = false;
                const next = () => {
                    if (nextCalled)
                        return;
                    nextCalled = true;
                    resolve();
                };
                try {
                    const result = mw(req, res, next);
                    // Handle async middleware
                    if (result instanceof Promise) {
                        result
                            .then(() => {
                            if (!nextCalled)
                                next();
                        })
                            .catch(reject);
                    }
                }
                catch (error) {
                    reject(error);
                }
            });
        }
    }
    listen(port, host, callback) {
        // Handle overloaded parameters (port, callback) or (port, host, callback)
        if (typeof host === 'function') {
            callback = host;
            host = undefined;
        }
        if (host) {
            this.server.listen(port, host, callback);
        }
        else {
            this.server.listen(port, callback);
        }
    }
    close() {
        return new Promise(resolve => {
            this.server.close(() => resolve());
        });
    }
    getServer() {
        return this.server;
    }
}
exports.MoroHttpServer = MoroHttpServer;
// Built-in middleware
exports.middleware = {
    cors: (options = {}) => {
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
    helmet: () => {
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
    compression: (options = {}) => {
        const zlib = require('zlib');
        const threshold = options.threshold || 1024;
        const level = options.level || 6;
        return (req, res, next) => {
            const acceptEncoding = req.headers['accept-encoding'] || '';
            // Override res.json to compress responses
            const originalJson = res.json;
            const originalSend = res.send;
            const compressResponse = (data, isJson = false) => {
                const content = isJson ? JSON.stringify(data) : data;
                const buffer = Buffer.from(content);
                if (buffer.length < threshold) {
                    return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
                }
                if (acceptEncoding.includes('gzip')) {
                    res.setHeader('Content-Encoding', 'gzip');
                    zlib.gzip(buffer, { level }, (err, compressed) => {
                        if (err) {
                            return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
                        }
                        res.setHeader('Content-Length', compressed.length);
                        res.writeHead(res.statusCode || 200, res.getHeaders());
                        res.end(compressed);
                    });
                }
                else if (acceptEncoding.includes('deflate')) {
                    res.setHeader('Content-Encoding', 'deflate');
                    zlib.deflate(buffer, { level }, (err, compressed) => {
                        if (err) {
                            return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
                        }
                        res.setHeader('Content-Length', compressed.length);
                        res.writeHead(res.statusCode || 200, res.getHeaders());
                        res.end(compressed);
                    });
                }
                else {
                    return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
                }
            };
            res.json = function (data) {
                // Ensure charset is set for Safari compatibility
                this.setHeader('Content-Type', 'application/json; charset=utf-8');
                compressResponse(data, true);
                return this;
            };
            res.send = function (data) {
                compressResponse(data, false);
                return this;
            };
            next();
        };
    },
    requestLogger: () => {
        return (req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                // Request completed - logged by framework
            });
            next();
        };
    },
    bodySize: (options = {}) => {
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
    static: (options) => {
        return async (req, res, next) => {
            // Only handle GET and HEAD requests
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                next();
                return;
            }
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
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
                    }
                    else if (options.dotfiles === 'ignore') {
                        next();
                        return;
                    }
                }
                let stats;
                try {
                    stats = await fs.stat(filePath);
                }
                catch (error) {
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
                        }
                        catch (error) {
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
                const mimeTypes = {
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
            }
            catch (error) {
                res.status(500).json({ success: false, error: 'Internal server error' });
            }
        };
    },
    upload: (options = {}) => {
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
                    const fileData = file;
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
    template: (options) => {
        const templateCache = new Map();
        return async (req, res, next) => {
            // Add render method to response
            res.render = async (template, data = {}) => {
                try {
                    const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                    const path = await Promise.resolve().then(() => __importStar(require('path')));
                    const templatePath = path.join(options.views, `${template}.html`);
                    let templateContent;
                    // Check cache first
                    if (options.cache && templateCache.has(templatePath)) {
                        templateContent = templateCache.get(templatePath);
                    }
                    else {
                        templateContent = await fs.readFile(templatePath, 'utf-8');
                        if (options.cache) {
                            templateCache.set(templatePath, templateContent);
                        }
                    }
                    // Simple template engine - replace {{variable}} with values
                    let rendered = templateContent;
                    // Handle basic variable substitution
                    rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match, key) => {
                        return data[key] !== undefined ? String(data[key]) : match;
                    });
                    // Handle nested object properties like {{user.name}}
                    rendered = rendered.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
                        const value = key.split('.').reduce((obj, prop) => obj?.[prop], data);
                        return value !== undefined ? String(value) : match;
                    });
                    // Handle loops: {{#each items}}{{name}}{{/each}}
                    rendered = rendered.replace(/\{\{#each (\w+)\}\}(.*?)\{\{\/each\}\}/gs, (match, arrayKey, template) => {
                        const array = data[arrayKey];
                        if (!Array.isArray(array))
                            return '';
                        return array
                            .map(item => {
                            let itemTemplate = template;
                            // Replace variables in the loop template
                            itemTemplate = itemTemplate.replace(/\{\{(\w+)\}\}/g, (match, key) => {
                                return item[key] !== undefined ? String(item[key]) : match;
                            });
                            return itemTemplate;
                        })
                            .join('');
                    });
                    // Handle conditionals: {{#if condition}}content{{/if}}
                    rendered = rendered.replace(/\{\{#if (\w+)\}\}(.*?)\{\{\/if\}\}/gs, (match, conditionKey, content) => {
                        const condition = data[conditionKey];
                        return condition ? content : '';
                    });
                    // Handle layout
                    if (options.defaultLayout) {
                        const layoutPath = path.join(options.views, 'layouts', `${options.defaultLayout}.html`);
                        try {
                            let layoutContent;
                            if (options.cache && templateCache.has(layoutPath)) {
                                layoutContent = templateCache.get(layoutPath);
                            }
                            else {
                                layoutContent = await fs.readFile(layoutPath, 'utf-8');
                                if (options.cache) {
                                    templateCache.set(layoutPath, layoutContent);
                                }
                            }
                            rendered = layoutContent.replace(/\{\{body\}\}/, rendered);
                        }
                        catch (error) {
                            // Layout not found, use template as-is
                        }
                    }
                    res.setHeader('Content-Type', 'text/html');
                    res.end(rendered);
                }
                catch (error) {
                    res.status(500).json({ success: false, error: 'Template rendering failed' });
                }
            };
            next();
        };
    },
    // HTTP/2 Server Push middleware
    http2Push: (options = {}) => {
        return (req, res, next) => {
            // Add HTTP/2 push capability to response
            res.push = (path, options = {}) => {
                // Check if HTTP/2 is supported
                if (req.httpVersion === '2.0' && res.stream && res.stream.pushAllowed) {
                    try {
                        const pushStream = res.stream.pushStream({
                            ':method': 'GET',
                            ':path': path,
                            ...options.headers,
                        });
                        if (pushStream) {
                            // Handle push stream
                            return pushStream;
                        }
                    }
                    catch (error) {
                        // Push failed, continue normally
                    }
                }
                return null;
            };
            // Auto-push configured resources
            if (options.resources && (!options.condition || options.condition(req))) {
                for (const resource of options.resources) {
                    res.push?.(resource.path, {
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
    sse: (options = {}) => {
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
                res.sendEvent = (data, event, id) => {
                    if (id)
                        res.write(`id: ${id}\n`);
                    if (event)
                        res.write(`event: ${event}\n`);
                    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
                };
                res.sendComment = (comment) => {
                    res.write(`: ${comment}\n\n`);
                };
                res.sendRetry = (ms) => {
                    res.write(`retry: ${ms}\n\n`);
                };
                // Set up heartbeat if configured
                let heartbeatInterval = null;
                if (options.heartbeat) {
                    heartbeatInterval = setInterval(() => {
                        res.sendComment('heartbeat');
                    }, options.heartbeat);
                }
                // Set retry if configured
                if (options.retry) {
                    res.sendRetry(options.retry);
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
    range: (options = {}) => {
        return async (req, res, next) => {
            // Add range support to response
            res.sendRange = async (filePath, stats) => {
                try {
                    const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                    const path = await Promise.resolve().then(() => __importStar(require('path')));
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
                    }
                    else {
                        // Multiple ranges - multipart response
                        const boundary = 'MULTIPART_BYTERANGES';
                        res.status(206);
                        res.setHeader('Content-Type', `multipart/byteranges; boundary=${boundary}`);
                        for (const { start, end } of ranges) {
                            if (start >= fileSize || end >= fileSize)
                                continue;
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
                }
                catch (error) {
                    res.status(500).json({ success: false, error: 'Range request failed' });
                }
            };
            next();
        };
    },
    // CSRF Protection middleware
    csrf: (options = {}) => {
        const secret = options.secret || 'moro-csrf-secret';
        const tokenLength = options.tokenLength || 32;
        const cookieName = options.cookieName || '_csrf';
        const headerName = options.headerName || 'x-csrf-token';
        const ignoreMethods = options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS'];
        const generateToken = () => {
            const crypto = require('crypto');
            return crypto.randomBytes(tokenLength).toString('hex');
        };
        const verifyToken = (token, sessionToken) => {
            return token && sessionToken && token === sessionToken;
        };
        return (req, res, next) => {
            // Add CSRF token generation method
            req.csrfToken = () => {
                if (!req._csrfToken) {
                    req._csrfToken = generateToken();
                    // Set token in cookie
                    res.cookie(cookieName, req._csrfToken, {
                        httpOnly: true,
                        sameSite: options.sameSite !== false ? 'strict' : undefined,
                        secure: req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted,
                    });
                }
                return req._csrfToken;
            };
            // Skip verification for safe methods
            if (ignoreMethods.includes(req.method)) {
                next();
                return;
            }
            // Get token from header or body
            const token = req.headers[headerName] || (req.body && req.body._csrf) || (req.query && req.query._csrf);
            // Get session token from cookie
            const sessionToken = req.cookies?.[cookieName];
            if (!verifyToken(token, sessionToken || '')) {
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
    csp: (options = {}) => {
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
            let nonce;
            if (options.nonce) {
                const crypto = require('crypto');
                nonce = crypto.randomBytes(16).toString('base64');
                req.cspNonce = nonce;
            }
            // Build CSP header value
            const cspParts = [];
            for (const [directive, sources] of Object.entries(directives)) {
                if (directive === 'upgradeInsecureRequests' && sources === true) {
                    cspParts.push('upgrade-insecure-requests');
                }
                else if (directive === 'blockAllMixedContent' && sources === true) {
                    cspParts.push('block-all-mixed-content');
                }
                else if (Array.isArray(sources)) {
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
function parseSize(size) {
    const units = {
        b: 1,
        kb: 1024,
        mb: 1024 * 1024,
        gb: 1024 * 1024 * 1024,
    };
    const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
    if (!match)
        return 1024 * 1024; // Default 1MB
    const value = parseFloat(match[1]);
    const unit = match[2] || 'b';
    return Math.round(value * units[unit]);
}
