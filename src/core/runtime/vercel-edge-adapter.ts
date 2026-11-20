// Vercel Edge runtime adapter
import {
  BaseRuntimeAdapter,
  InvalidRequestBodyError,
  finishResponse,
  handlerFailureBody,
  invalidBodyResponse,
  parseCookieHeader,
  readJsonBody,
  toWebResponse,
} from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';

export class VercelEdgeAdapter extends BaseRuntimeAdapter {
  readonly type = 'vercel-edge' as const;

  // The URL the platform hands over carries the scheme the client used
  protected override requestOverTls(request: HttpRequest): boolean {
    const url = request.url;
    return typeof url === 'string' && url.startsWith('https://');
  }

  async adaptRequest(request: Request): Promise<HttpRequest> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const url = new URL(request.url);
    const { pathname, query } = this.parseUrl(request.url);

    // Parse body for POST/PUT/PATCH requests
    let body: any;
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        body = await readJsonBody(request);
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
      ip: this.getClientIP(headers),
      params: {},
      requestId: '',
      cookies: parseCookieHeader(headers.cookie || ''),
      files: {},
    } as Partial<HttpRequest>;

    return this.enhanceRequest(baseRequest);
  }

  async adaptResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Promise<Response> {
    return toWebResponse(moroResponse);
  }

  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>) {
    // Return a Vercel Edge-compatible handler function
    return async (request: Request) => {
      let requestId: string | undefined;
      try {
        const moroReq = await this.adaptRequest(request);
        requestId = moroReq.requestId;
        const moroRes = this.createMockResponse(moroReq);

        await handler(moroReq, moroRes as any);
        finishResponse(moroRes);

        return await this.adaptResponse(moroRes);
      } catch (error) {
        // A body that does not parse is the client's error, answered as on the Node server
        if (error instanceof InvalidRequestBodyError) {
          return invalidBodyResponse(this.generateUUID());
        }
        return new Response(handlerFailureBody(error, requestId), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    };
  }

  // Vercel Edge doesn't have a listen method - it's handled by the platform
  // listen method is optional in the interface

  private getClientIP(headers: Record<string, string>): string {
    return headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'] || 'unknown';
  }
}
