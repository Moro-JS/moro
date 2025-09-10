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
exports.NodeRuntimeAdapter = void 0;
const base_adapter_1 = require("./base-adapter");
const http_server_1 = require("../http/http-server");
class NodeRuntimeAdapter extends base_adapter_1.BaseRuntimeAdapter {
    type = 'node';
    async adaptRequest(req) {
        const { pathname, query } = this.parseUrl(req.url || '/');
        // Parse body for POST/PUT/PATCH requests
        let body;
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            body = await this.parseRequestBody(req);
        }
        const baseRequest = {
            // Copy IncomingMessage properties we need
            method: req.method,
            url: req.url,
            headers: req.headers,
            httpVersion: req.httpVersion,
            httpVersionMajor: req.httpVersionMajor,
            httpVersionMinor: req.httpVersionMinor,
            socket: req.socket,
            // Add MoroJS-specific properties
            path: pathname,
            query,
            body,
            ip: this.getClientIP(req),
            params: {},
            requestId: '',
            cookies: {},
            files: {},
        };
        return this.enhanceRequest(baseRequest);
    }
    async adaptResponse(moroResponse, req) {
        // For Node.js, we typically work with the actual ServerResponse
        // This method is mainly for converting mock responses back to real ones
        return moroResponse;
    }
    createServer(handler) {
        const httpServer = new http_server_1.MoroHttpServer();
        // Replace the default request handler with our runtime-aware handler
        const originalServer = httpServer.getServer();
        originalServer.removeAllListeners('request');
        originalServer.on('request', async (req, res) => {
            try {
                const moroReq = await this.adaptRequest(req);
                const moroRes = this.enhanceResponse(res);
                await handler(moroReq, moroRes);
            }
            catch (error) {
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Internal server error',
                        message: error instanceof Error ? error.message : 'Unknown error',
                    }));
                }
            }
        });
        return httpServer;
    }
    listen(server, port, host, callback) {
        server.listen(port, host, callback);
    }
    // Helper methods
    async parseRequestBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const contentType = req.headers['content-type'] || '';
                    resolve(this.parseBody(body, contentType));
                }
                catch (error) {
                    reject(error);
                }
            });
            req.on('error', reject);
        });
    }
    getClientIP(req) {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            return forwarded.split(',')[0].trim();
        }
        return req.socket.remoteAddress || 'unknown';
    }
    enhanceResponse(res) {
        const enhanced = res;
        // Add MoroJS response methods if they don't exist
        if (!enhanced.json) {
            enhanced.json = function (data) {
                this.setHeader('Content-Type', 'application/json');
                this.end(JSON.stringify(data));
            };
        }
        if (!enhanced.status) {
            enhanced.status = function (code) {
                this.statusCode = code;
                return this;
            };
        }
        if (!enhanced.send) {
            enhanced.send = function (data) {
                this.end(data);
            };
        }
        if (!enhanced.cookie) {
            enhanced.cookie = function (name, value, options) {
                const cookieString = `${name}=${value}`;
                this.setHeader('Set-Cookie', cookieString);
                return this;
            };
        }
        if (!enhanced.clearCookie) {
            enhanced.clearCookie = function (name, options) {
                this.setHeader('Set-Cookie', `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
                return this;
            };
        }
        if (!enhanced.redirect) {
            enhanced.redirect = function (url, status) {
                this.statusCode = status || 302;
                this.setHeader('Location', url);
                this.end();
            };
        }
        if (!enhanced.sendFile) {
            enhanced.sendFile = async function (filePath) {
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                try {
                    const data = await fs.promises.readFile(filePath);
                    const ext = path.extname(filePath);
                    // Basic content type detection
                    const contentTypes = {
                        '.html': 'text/html',
                        '.js': 'application/javascript',
                        '.css': 'text/css',
                        '.json': 'application/json',
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg',
                        '.gif': 'image/gif',
                        '.svg': 'image/svg+xml',
                    };
                    const contentType = contentTypes[ext] || 'application/octet-stream';
                    this.setHeader('Content-Type', contentType);
                    this.end(data);
                }
                catch (error) {
                    this.statusCode = 404;
                    this.end('File not found');
                }
            };
        }
        return enhanced;
    }
}
exports.NodeRuntimeAdapter = NodeRuntimeAdapter;
