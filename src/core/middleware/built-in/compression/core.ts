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
    const acceptEncoding = (req.headers['accept-encoding'] as string) || '';
    const level = this.level;
    const threshold = this.threshold;

    const pickEncoding = (): 'gzip' | 'deflate' | null =>
      acceptEncoding.includes('gzip')
        ? 'gzip'
        : acceptEncoding.includes('deflate')
          ? 'deflate'
          : null;

    const compressResponse = (data: any, isJson: boolean) => {
      const content = isJson ? JSON.stringify(data) : data;
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
      const encoding = pickEncoding();

      // Below the threshold, or the client can't accept compression: fall back to the
      // original (synchronous) response path unchanged.
      if (buffer.length < threshold || !encoding) {
        return isJson ? originalJson.call(res, data) : originalSend.call(res, data);
      }

      // Commit the response headers synchronously, BEFORE the asynchronous gzip. This
      // marks the response as sent (`headersSent === true`) the moment `send`/`json` is
      // called, so the request lifecycle's "no route matched" fallback can't fire and
      // 404 the response while compression is still pending (the race that previously
      // broke any middleware-served compressed response, e.g. the Swagger docs page).
      // The compressed length isn't known yet, so the body streams (chunked) rather
      // than carrying a Content-Length.
      if (!res.headersSent) {
        res.setHeader('Content-Encoding', encoding);
        (res as any).writeHead((res as any).statusCode || 200);
      }

      const finish = (err: Error | null, compressed: Buffer) => {
        // Headers (including Content-Encoding) are already committed, so we can't fall
        // back to a raw body on the rare compression error — end without one.
        res.end(err ? undefined : compressed);
      };

      if (encoding === 'gzip') {
        zlib.gzip(buffer, { level }, finish);
      } else {
        zlib.deflate(buffer, { level }, finish);
      }
    };

    res.json = function (data: any) {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
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
