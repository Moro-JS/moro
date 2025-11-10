// Cloudflare Workers runtime adapter
import { BaseRuntimeAdapter } from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';

export interface WorkersEnv {
  [key: string]: any;
}

export interface WorkersContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

export class CloudflareWorkersAdapter extends BaseRuntimeAdapter {
  readonly type = 'cloudflare-workers' as const;

  async adaptRequest(request: Request, env: WorkersEnv, ctx: WorkersContext): Promise<HttpRequest> {
    const { pathname, query } = this.parseUrl(request.url);

    // Parse body for POST/PUT/PATCH requests
    let body: any;
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          body = await request.json();
        } catch {
          body = await request.text();
        }
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        body = await request.formData();
        // Convert FormData to object
        const formObject: Record<string, any> = {};
        body.forEach((value: any, key: string) => {
          formObject[key] = value;
        });
        body = formObject;
      } else {
        body = await request.text();
      }
    }

    // Convert Headers to plain object - pre-allocate size hint
    const headers: Record<string, string> = Object.create(null);
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const baseRequest = {
      method: request.method,
      url: request.url,
      path: pathname,
      query,
      body,
      headers,
      ip: this.getClientIP(headers, request),
      params: {},
      requestId: '',
      cookies: this.parseCookies(headers.cookie || ''),
      files: {},
      // Add Workers-specific context
      env,
      ctx,
    } as Partial<HttpRequest>;

    return this.enhanceRequest(baseRequest);
  }

  async adaptResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Promise<Response> {
    const runtimeResponse = moroResponse as RuntimeHttpResponse;

    // Handle different response states
    let body = runtimeResponse.body;
    let status = runtimeResponse.statusCode || 200;
    const headers = runtimeResponse.headers || {};

    // If it's a real HttpResponse, we need to extract the data differently
    if ('statusCode' in moroResponse && typeof moroResponse.statusCode === 'number') {
      status = moroResponse.statusCode;
    }

    // Convert headers to Headers object - Avoid Object.entries
    const responseHeaders = new Headers();
    for (const key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key)) {
        const value = headers[key];
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            responseHeaders.append(key, value[i]);
          }
        } else {
          responseHeaders.set(key, value);
        }
      }
    }

    // Handle different body types
    if (typeof body === 'object' && body !== null) {
      body = JSON.stringify(body);
      responseHeaders.set('Content-Type', 'application/json');
    }

    return new Response(body, {
      status,
      headers: responseHeaders,
    });
  }

  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>) {
    // Return a Cloudflare Workers-compatible handler function
    return async (request: Request, env: WorkersEnv, ctx: WorkersContext) => {
      try {
        const moroReq = await this.adaptRequest(request, env, ctx);
        const moroRes = this.createMockResponse();

        await handler(moroReq, moroRes as any);

        return await this.adaptResponse(moroRes);
      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    };
  }

  // Cloudflare Workers doesn't have a listen method - it's handled by the platform
  // listen method is optional in the interface

  private getClientIP(headers: Record<string, string>, _request: Request): string {
    // Cloudflare provides the real IP in CF-Connecting-IP header
    return (
      headers['cf-connecting-ip'] ||
      headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      headers['x-real-ip'] ||
      'unknown'
    );
  }

  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) return cookies;

    // Avoid split/forEach, use single pass
    let start = 0;
    const len = cookieHeader.length;

    for (let i = 0; i <= len; i++) {
      if (i === len || cookieHeader[i] === ';') {
        if (i > start) {
          const cookie = cookieHeader.substring(start, i).trim();
          const equalIndex = cookie.indexOf('=');
          if (equalIndex > 0) {
            const name = cookie.substring(0, equalIndex);
            const value = cookie.substring(equalIndex + 1);
            if (name && value) {
              cookies[name] = value;
            }
          }
        }
        start = i + 1;
      }
    }

    return cookies;
  }
}
