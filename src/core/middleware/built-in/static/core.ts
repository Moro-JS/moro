// Static File Serving Core Logic
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export interface StaticOptions {
  root: string;
  maxAge?: number;
  index?: string[];
  dotfiles?: 'allow' | 'deny' | 'ignore';
  etag?: boolean;
}

export class StaticCore {
  private root: string;
  private maxAge: number;
  private index: string[];
  private dotfiles: 'allow' | 'deny' | 'ignore';
  private etag: boolean;

  private mimeTypes: Record<string, string> = {
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
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
  };

  constructor(options: StaticOptions) {
    this.root = path.resolve(options.root);
    this.maxAge = options.maxAge || 0;
    this.index = options.index || ['index.html', 'index.htm'];
    this.dotfiles = options.dotfiles || 'ignore';
    this.etag = options.etag !== false;
  }

  async handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    // Only handle GET and HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }

    try {
      let filePath = path.join(this.root, req.path);

      // Security: prevent directory traversal
      if (!filePath.startsWith(this.root)) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return true;
      }

      // Handle dotfiles
      const basename = path.basename(filePath);
      if (basename.startsWith('.')) {
        if (this.dotfiles === 'deny') {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return true;
        } else if (this.dotfiles === 'ignore') {
          return false;
        }
      }

      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        return false; // File not found, let other middleware handle
      }

      // Handle directories
      if (stats.isDirectory()) {
        let indexFound = false;

        for (const indexFile of this.index) {
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
          return false;
        }
      }

      // Get mime type and add charset for text files
      const ext = path.extname(filePath);
      const baseMimeType = this.mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
      const contentType = this.addCharsetIfNeeded(baseMimeType);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stats.size);

      // Cache headers
      if (this.maxAge > 0) {
        res.setHeader('Cache-Control', `public, max-age=${this.maxAge}`);
      }

      // ETag support
      if (this.etag) {
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
          return true;
        }
      }

      // Handle HEAD requests
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      // Send file
      const data = await fs.readFile(filePath);
      res.end(data);
      return true;
    } catch {
      res.status(500).json({ success: false, error: 'Internal server error' });
      return true;
    }
  }

  private addCharsetIfNeeded(mimeType: string): string {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/xml',
      'image/svg+xml',
    ];
    const needsCharset = textTypes.some(type => mimeType.startsWith(type));
    return needsCharset ? `${mimeType}; charset=utf-8` : mimeType;
  }

  getRoot(): string {
    return this.root;
  }
}
