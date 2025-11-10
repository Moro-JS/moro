// Base runtime adapter with common functionality
import { RuntimeAdapter, RuntimeType, RuntimeHttpResponse } from '../../types/runtime.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { randomBytes } from 'crypto';

export abstract class BaseRuntimeAdapter implements RuntimeAdapter {
  abstract readonly type: RuntimeType;

  abstract adaptRequest(runtimeRequest: any, ...args: any[]): Promise<HttpRequest>;
  abstract adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    runtimeRequest: any
  ): Promise<any>;
  abstract createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): any;

  // Generate UUID without external dependency - optimized version
  protected generateUUID(): string {
    const bytes = randomBytes(16);
    // Set version (4) and variant bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    // Convert to hex string directly without intermediate operations
    const hex = bytes.toString('hex');
    return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
  }

  // Common request enhancement
  protected enhanceRequest(baseRequest: Partial<HttpRequest>): HttpRequest {
    const request = baseRequest as HttpRequest;

    // Add common properties
    request.requestId = request.requestId || this.generateUUID();
    request.ip = request.ip || 'unknown';
    request.params = request.params || {};
    request.query = request.query || {};
    request.cookies = request.cookies || {};
    request.files = request.files || {};

    return request;
  }

  // Common response enhancement
  protected createMockResponse(): RuntimeHttpResponse {
    const response: RuntimeHttpResponse = {
      statusCode: 200,
      headers: {},
      body: null,
      headersSent: false,

      status: function (code: number) {
        this.statusCode = code;
        return this;
      },

      json: function (data: any) {
        this.headers['Content-Type'] = 'application/json';
        // Avoid JSON.stringify if data is already a string
        if (typeof data === 'string') {
          this.body = data;
        } else {
          this.body = JSON.stringify(data);
        }
        this.headersSent = true;
      },

      send: function (data: string | Buffer) {
        this.body = data;
        this.headersSent = true;
      },

      cookie: function (name: string, value: string, _options?: any) {
        // Simple cookie implementation
        const cookieString = `${name}=${value}`;
        this.headers['Set-Cookie'] = cookieString;
        return this;
      },

      clearCookie: function (name: string, _options?: any) {
        this.headers['Set-Cookie'] = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
        return this;
      },

      redirect: function (url: string, status?: number) {
        this.statusCode = status || 302;
        this.headers['Location'] = url;
        this.headersSent = true;
      },

      sendFile: async function (_filePath: string) {
        throw new Error('sendFile not implemented in this runtime');
      },
    };

    return response;
  }

  // Parse URL and query parameters
  protected parseUrl(url: string): {
    pathname: string;
    query: Record<string, string>;
  } {
    try {
      const urlObj = new URL(url, 'http://localhost');
      const query: Record<string, string> = {};

      urlObj.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      return {
        pathname: urlObj.pathname,
        query,
      };
    } catch {
      return {
        pathname: url,
        query: {},
      };
    }
  }

  // Parse body based on content type
  protected async parseBody(body: any, contentType?: string): Promise<any> {
    if (!body) return undefined;

    if (typeof body === 'string') {
      if (contentType?.includes('application/json')) {
        try {
          return JSON.parse(body);
        } catch {
          return body;
        }
      }
      return body;
    }

    return body;
  }
}
