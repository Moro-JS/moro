// Body Size Limit Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { isMultipartMediaType } from '../../../http/utils/body-type.js';

export interface BodySizeOptions {
  limit?: string | number;
}

/**
 * The size of a request's body, in bytes. A request with Content-Length is
 * judged by the header and nothing more. One without it (chunked) declares
 * nothing, so it is measured by what was received: the retained raw bytes
 * when the server kept them, else the body itself when it is still a string
 * or a Buffer, else (a parsed object with no raw bytes behind it) its
 * serialized length - the closest measure left. 0 when there is no body.
 */
export function requestBodyBytes(req: HttpRequest): number {
  const declared = req.headers['content-length'];
  if (declared !== undefined) return parseInt(declared || '0');

  const body = req.body;
  if (body === undefined || body === null) return 0;
  const raw = req.rawBody;
  if (Buffer.isBuffer(raw)) return raw.length;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'object') {
    try {
      return Buffer.byteLength(JSON.stringify(body) ?? '');
    } catch {
      return 0; // not serializable: nothing to measure
    }
  }
  return 0;
}

export class BodySizeCore {
  private limitBytes: number;

  constructor(options: BodySizeOptions = {}) {
    this.limitBytes = this.parseSize(options.limit || '10mb');
  }

  private parseSize(size: string | number): number {
    if (typeof size === 'number') {
      return size;
    }

    const units: { [key: string]: number } = {
      b: 1,
      kb: 1024,
      mb: 1024 * 1024,
      gb: 1024 * 1024 * 1024,
    };

    const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
    if (!match) return 10 * 1024 * 1024; // Default 10MB

    const value = parseFloat(match[1] ?? '');
    const unit = match[2] || 'b';

    return Math.round(value * (units[unit] ?? 1));
  }

  checkBodySize(req: HttpRequest, res: HttpResponse): boolean {
    // Skip body size check for multipart/form-data (file uploads)
    // Those are handled by maxUploadSize in the HTTP server's parseBody method.
    // The media type itself decides, not a substring: `application/json;
    // x=multipart/form-data` is a JSON request and is checked like one.
    if (isMultipartMediaType(req.headers['content-type'])) {
      return true; // Allow, will be checked by parseBody with maxUploadSize limit
    }

    const contentLength = requestBodyBytes(req);

    if (contentLength > this.limitBytes) {
      res.status(413).json({
        success: false,
        error: 'Request entity too large',
        limit: this.formatSize(this.limitBytes),
        received: this.formatSize(contentLength),
      });
      return false;
    }

    return true;
  }

  private formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
    } else if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
    } else if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(2)}KB`;
    }
    return `${bytes}B`;
  }

  getLimit(): number {
    return this.limitBytes;
  }
}
