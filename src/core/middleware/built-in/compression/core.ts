// Compression Core Logic
//
// The global compression middleware wraps res.json/res.send uniformly across
// EVERY runtime (Node, uWS, HTTP/2, engine), so it is the single source of
// response compression parity. It delegates encoding choice and content-type
// filtering to the shared utility (utils/compression) so brotli, q-value
// negotiation, and the compressible-type allowlist behave identically here and
// in the per-server fallback paths.
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import {
  compressBuffer,
  negotiateEncoding,
  isCompressible,
  DEFAULT_ENCODINGS,
  type Encoding,
} from '../../../http/utils/compression.js';

export interface CompressionOptions {
  threshold?: number;
  level?: number;
  encodings?: Encoding[];
  filter?: (req: HttpRequest, res: HttpResponse) => boolean;
}

export class CompressionCore {
  private threshold: number;
  private level: number;
  private encodings: Encoding[];
  private filter?: (req: HttpRequest, res: HttpResponse) => boolean;

  constructor(options: CompressionOptions = {}) {
    this.threshold = options.threshold || 1024; // 1KB default
    this.level = options.level || 6; // Default compression level
    this.encodings = options.encodings || DEFAULT_ENCODINGS;
    this.filter = options.filter;
  }

  shouldCompress(req: HttpRequest, res: HttpResponse): boolean {
    // Check custom filter
    if (this.filter && !this.filter(req, res)) {
      return false;
    }

    // Check if client accepts any encoding we offer
    const acceptEncoding = (req.headers['accept-encoding'] as string) || '';
    return negotiateEncoding(acceptEncoding, this.encodings) !== null;
  }

  wrapResponse(req: HttpRequest, res: HttpResponse): void {
    const originalSend = res.send;
    const acceptEncoding = (req.headers['accept-encoding'] as string) || '';
    const level = this.level;
    const threshold = this.threshold;
    const encodings = this.encodings;
    const filterOk = this.filter ? this.filter(req, res) : true;

    const compressResponse = (data: any, isJson: boolean, contentType?: string) => {
      const content = isJson ? JSON.stringify(data) : data;
      const byteLength = Buffer.isBuffer(content)
        ? content.length
        : Buffer.byteLength(content ?? '');
      const ctHeader =
        contentType ??
        (res.getHeader ? (res.getHeader('content-type') as string | undefined) : undefined);
      const encoding = filterOk ? negotiateEncoding(acceptEncoding, encodings) : null;

      // Skip compression when: below threshold, client accepts nothing we
      // offer, or the content type isn't worth compressing (already-compressed
      // binary - images, video, octet-stream). For JSON we already have the
      // serialized string; ending with it here avoids re-entering res.json,
      // which would JSON.stringify the same data a second time.
      if (byteLength < threshold || !encoding || !isCompressible(ctHeader)) {
        if (isJson) {
          if (res.headersSent) return;
          res.setHeader('Content-Length', byteLength);
          res.end(content);
          return;
        }
        return originalSend.call(res, data);
      }

      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');

      // Commit the response headers synchronously, BEFORE the asynchronous
      // compression. This marks headersSent the moment send/json is called, so
      // the "no route matched" fallback can't 404 the response mid-compress.
      // The compressed length isn't known yet, so the body streams (chunked).
      if (!res.headersSent) {
        res.setHeader('Content-Encoding', encoding);
        const vary = res.getHeader ? (res.getHeader('vary') as string | undefined) : undefined;
        res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
        (res as any).writeHead((res as any).statusCode || 200);
      }

      compressBuffer(buffer, encoding, level)
        .then(compressed => res.end(compressed))
        .catch(() => res.end()); // headers already committed - can't fall back to raw

      return res;
    };

    res.json = function (data: any) {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      compressResponse(data, true, 'application/json');
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
