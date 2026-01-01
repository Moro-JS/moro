// Body Size Limit Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

export interface BodySizeOptions {
  limit?: string | number;
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

    const value = parseFloat(match[1]);
    const unit = match[2] || 'b';

    return Math.round(value * units[unit]);
  }

  checkBodySize(req: HttpRequest, res: HttpResponse): boolean {
    const contentType = req.headers['content-type'] || '';

    // Skip body size check for multipart/form-data (file uploads)
    // Those are handled by maxUploadSize in the HTTP server's parseBody method
    if (contentType.includes('multipart/form-data')) {
      return true; // Allow, will be checked by parseBody with maxUploadSize limit
    }

    const contentLength = parseInt(req.headers['content-length'] || '0');

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
