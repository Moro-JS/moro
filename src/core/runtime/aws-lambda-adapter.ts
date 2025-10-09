// AWS Lambda runtime adapter
import { BaseRuntimeAdapter } from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';

export interface LambdaEvent {
  httpMethod: string;
  path: string;
  pathParameters?: Record<string, string> | null;
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  multiValueHeaders?: Record<string, string[]> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    identity?: {
      sourceIp?: string;
    };
  };
}

export interface LambdaContext {
  requestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis(): number;
}

export interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
  isBase64Encoded?: boolean;
}

export class AWSLambdaAdapter extends BaseRuntimeAdapter {
  readonly type = 'aws-lambda' as const;

  async adaptRequest(event: LambdaEvent, context: LambdaContext): Promise<HttpRequest> {
    const { pathname, query } = this.parseUrl(event.path);

    // Merge query parameters from event
    const mergedQuery = {
      ...query,
      ...(event.queryStringParameters || {}),
    };

    // Parse body
    let body: any;
    if (event.body) {
      const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
      if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString();
      } else {
        body = event.body;
      }
      body = await this.parseBody(body, contentType);
    }

    const baseRequest = {
      method: event.httpMethod,
      url: event.path,
      path: pathname,
      query: mergedQuery,
      body,
      headers: event.headers || {},
      ip: event.requestContext?.identity?.sourceIp || 'unknown',
      params: event.pathParameters || {},
      requestId: context.awsRequestId,
      cookies: this.parseCookies(event.headers?.cookie || ''),
      files: {},
    } as Partial<HttpRequest>;

    return this.enhanceRequest(baseRequest);
  }

  async adaptResponse(moroResponse: HttpResponse | RuntimeHttpResponse): Promise<LambdaResponse> {
    const runtimeResponse = moroResponse as RuntimeHttpResponse;

    let body = runtimeResponse.body;
    const status = runtimeResponse.statusCode || 200;
    const headers = runtimeResponse.headers || {};

    // Convert body to string
    if (typeof body === 'object' && body !== null) {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    } else if (body === null || body === undefined) {
      body = '';
    } else {
      body = String(body);
    }

    return {
      statusCode: status,
      headers,
      body,
      isBase64Encoded: false,
    };
  }

  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>) {
    // Return a Lambda-compatible handler function
    return async (event: LambdaEvent, context: LambdaContext) => {
      try {
        const moroReq = await this.adaptRequest(event, context);
        const moroRes = this.createMockResponse();

        await handler(moroReq, moroRes as any);

        return await this.adaptResponse(moroRes);
      } catch (error) {
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
        };
      }
    };
  }

  // Lambda doesn't have a listen method - it's event-driven
  // listen method is optional in the interface

  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (cookieHeader) {
      cookieHeader.split(';').forEach(cookie => {
        const [name, ...rest] = cookie.trim().split('=');
        if (name && rest.length > 0) {
          cookies[name] = rest.join('=');
        }
      });
    }
    return cookies;
  }
}
