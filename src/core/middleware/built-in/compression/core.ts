// Compression Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as zlib from 'zlib';

export interface CompressionOptions {
  threshold?: number;
  level?: number;
  filter?: (req: HttpRequest, res: HttpResponse) => boolean;
}

export class CompressionCore {
  private threshold: number;
  private level: number;
  private filter?: (req: HttpRequest, res: HttpResponse) => boolean;

  constructor(options: CompressionOptions = {}) {
    this.threshold = options.threshold || 1024; // 1KB default
    this.level = options.level || 6; // Default compression level
    this.filter = options.filter;
  }

  shouldCompress(req: HttpRequest, res: HttpResponse): boolean {
    // Check custom filter
    if (this.filter && !this.filter(req, res)) {
      return false;
    }

    // Check if client accepts compression
    const acceptEncoding = req.headers['accept-encoding'] || '';
    return acceptEncoding.includes('gzip') || acceptEncoding.includes('deflate');
  }

  wrapResponse(req: HttpRequest, res: HttpResponse): void {
    const originalJson = res.json;
    const originalSend = res.send;
    const acceptEncoding = req.headers['accept-encoding'] || '';

    const compressResponse = (data: any, isJson = false) => {
      const content = isJson ? JSON.stringify(data) : data;
      const buffer = Buffer.from(content);

      if (buffer.length < this.threshold) {
        return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
      }

      if (acceptEncoding.includes('gzip')) {
        zlib.gzip(buffer, { level: this.level }, (err: any, compressed: Buffer) => {
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
        zlib.deflate(buffer, { level: this.level }, (err: any, compressed: Buffer) => {
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
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
      compressResponse(data, true);
      return this;
    };

    res.send = function (data: any) {
      compressResponse(data, false);
      return this;
    };
  }

  getThreshold(): number {
    return this.threshold;
  }

  getLevel(): number {
    return this.level;
  }
}
