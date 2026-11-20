// Node.js runtime adapter
import type { IncomingMessage, ServerResponse } from 'http';
import { BaseRuntimeAdapter, handlerFailureBody } from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';
import { MoroHttpServer, MoroServerResponse } from '../http/http-server.js';

export class NodeRuntimeAdapter extends BaseRuntimeAdapter {
  readonly type = 'node' as const;

  async adaptRequest(req: IncomingMessage): Promise<HttpRequest> {
    const { pathname, query } = this.parseUrl(req.url || '/');

    // Parse body for POST/PUT/PATCH requests
    let body: any;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (['POST', 'PUT', 'PATCH'].includes(req.method!)) {
      body = await this.parseRequestBody(req);
    }

    const baseRequest = {
      // Copy IncomingMessage properties we need
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      method: req.method!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    _req: IncomingMessage
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

    originalServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        let requestId: string | undefined;
        try {
          const moroReq = await this.adaptRequest(req);
          requestId = moroReq.requestId;
          const moroRes = this.enhanceResponse(res, httpServer);

          await handler(moroReq, moroRes);
        } catch (error) {
          const body = handlerFailureBody(error, requestId);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
          }
        }
      })();
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
      return forwarded.split(',')[0]?.trim() ?? 'unknown';
    }
    return req.socket.remoteAddress || 'unknown';
  }

  private enhanceResponse(res: ServerResponse, server: MoroHttpServer): HttpResponse {
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
      enhanced.cookie = function (name: string, value: string, _options?: any) {
        if (!this.headersSent) {
          const cookieString = `${name}=${value}`;
          this.setHeader('Set-Cookie', cookieString);
        }
        return this;
      };
    }

    if (!enhanced.clearCookie) {
      enhanced.clearCookie = function (name: string, _options?: any) {
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
      // The Node server's own sendFile, so that a response which is not of
      // the server's response class sends a file the same way: a large file
      // is streamed, the options (maxAge in seconds, immutable, cacheControl,
      // root, dotfiles) apply, and a file that cannot be served is the same
      // 404 or 403. It asks its server for the content type and writes the
      // body to the response itself.
      if (enhanced._server === undefined) enhanced._server = server;
      if (!enhanced._bodyStream) {
        enhanced._bodyStream = function () {
          return this;
        };
      }
      enhanced.sendFile = MoroServerResponse.prototype.sendFile;
    }

    return enhanced;
  }
}
