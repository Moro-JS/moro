// Vercel Edge runtime adapter
import { BaseRuntimeAdapter } from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';

export class VercelEdgeAdapter extends BaseRuntimeAdapter {
  readonly type = 'vercel-edge' as const;

  async adaptRequest(request: Request): Promise<HttpRequest> {
    const url = new URL(request.url);
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
      } else {
        body = await request.text();
      }
    }

    // Convert Headers to plain object
    const headers: Record<string, string> = {};
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
      ip: this.getClientIP(headers),
      params: {},
      requestId: '',
      cookies: {},
      files: {},
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

    // Convert headers to Headers object
    const responseHeaders = new Headers();
    Object.entries(headers).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });

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
    // Return a Vercel Edge-compatible handler function
    return async (request: Request) => {
      try {
        const moroReq = await this.adaptRequest(request);
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

  // Vercel Edge doesn't have a listen method - it's handled by the platform
  // listen method is optional in the interface

  private getClientIP(headers: Record<string, string>): string {
    return headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'] || 'unknown';
  }
}
