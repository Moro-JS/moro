// Node.js runtime adapter
import { IncomingMessage, ServerResponse } from 'http';
import { BaseRuntimeAdapter } from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';
import { MoroHttpServer } from '../http/http-server.js';

export class NodeRuntimeAdapter extends BaseRuntimeAdapter {
  readonly type = 'node' as const;

  async adaptRequest(req: IncomingMessage): Promise<HttpRequest> {
    const { pathname, query } = this.parseUrl(req.url || '/');

    // Parse body for POST/PUT/PATCH requests
    let body: any;
    if (['POST', 'PUT', 'PATCH'].includes(req.method!)) {
      body = await this.parseRequestBody(req);
    }

    const baseRequest = {
      // Copy IncomingMessage properties we need
      method: req.method!,
      url: req.url!,
      headers: req.headers as Record<string, string>,
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
    } as Partial<HttpRequest>;

    return this.enhanceRequest(baseRequest);
  }

  async adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    req: IncomingMessage
  ): Promise<ServerResponse> {
    // For Node.js, we typically work with the actual ServerResponse
    // This method is mainly for converting mock responses back to real ones
    return moroResponse as any;
  }

  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): MoroHttpServer {
    const httpServer = new MoroHttpServer();

    // Replace the default request handler with our runtime-aware handler
    const originalServer = httpServer.getServer();
    originalServer.removeAllListeners('request');

    originalServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const moroReq = await this.adaptRequest(req);
        const moroRes = this.enhanceResponse(res);

        await handler(moroReq, moroRes);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              success: false,
              error: 'Internal server error',
              message: error instanceof Error ? error.message : 'Unknown error',
            })
          );
        }
      }
    });

    return httpServer;
  }

  listen(server: MoroHttpServer, port: number, host?: string, callback?: () => void): void {
    server.listen(port, host as any, callback);
  }

  // Helper methods
  private async parseRequestBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const contentType = req.headers['content-type'] || '';
          resolve(this.parseBody(body, contentType));
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  private getClientIP(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'] as string;
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  private enhanceResponse(res: ServerResponse): HttpResponse {
    const enhanced = res as any;

    // Add MoroJS response methods if they don't exist
    if (!enhanced.json) {
      enhanced.json = function (data: any) {
        this.setHeader('Content-Type', 'application/json');
        this.end(JSON.stringify(data));
      };
    }

    if (!enhanced.status) {
      enhanced.status = function (code: number) {
        this.statusCode = code;
        return this;
      };
    }

    if (!enhanced.send) {
      enhanced.send = function (data: string | Buffer) {
        this.end(data);
      };
    }

    if (!enhanced.cookie) {
      enhanced.cookie = function (name: string, value: string, options?: any) {
        if (!this.headersSent) {
          const cookieString = `${name}=${value}`;
          this.setHeader('Set-Cookie', cookieString);
        }
        return this;
      };
    }

    if (!enhanced.clearCookie) {
      enhanced.clearCookie = function (name: string, options?: any) {
        if (!this.headersSent) {
          this.setHeader('Set-Cookie', `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        }
        return this;
      };
    }

    if (!enhanced.redirect) {
      enhanced.redirect = function (url: string, status?: number) {
        if (!this.headersSent) {
          this.statusCode = status || 302;
          this.setHeader('Location', url);
          this.end();
        }
      };
    }

    if (!enhanced.sendFile) {
      enhanced.sendFile = async function (filePath: string) {
        const fs = await import('fs');
        const path = await import('path');

        try {
          const data = await fs.promises.readFile(filePath);
          const ext = path.extname(filePath);

          // Basic content type detection
          const contentTypes: Record<string, string> = {
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
        } catch (error) {
          this.statusCode = 404;
          this.end('File not found');
        }
      };
    }

    return enhanced;
  }
}
