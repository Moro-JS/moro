// AWS Lambda runtime adapter
import {
  BaseRuntimeAdapter,
  bytesOf,
  finishResponse,
  handlerFailureBody,
  headerKeyOf,
  multipleCookiesOf,
  parseCookieHeader,
} from './base-adapter.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RuntimeHttpResponse } from '../../types/runtime.js';
import { firstForwarded } from '../http/utils/trust-proxy.js';
import { parseRawQueryString } from '../http/utils/query-parser.js';

/**
 * The event of an API Gateway REST API (or an HTTP API on payload format 1.0)
 * and of an Application Load Balancer target group. A load balancer with
 * multi-value headers enabled sends `multiValueHeaders` and
 * `multiValueQueryStringParameters` in place of the single-value fields.
 */
export interface LambdaEvent {
  httpMethod: string;
  path: string;
  pathParameters?: Record<string, string> | null;
  queryStringParameters?: Record<string, string> | null;
  multiValueQueryStringParameters?: Record<string, string[]> | null;
  headers?: Record<string, string> | null;
  multiValueHeaders?: Record<string, string[]> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    identity?: {
      sourceIp?: string;
    };
    /** Present when the event comes from an Application Load Balancer */
    elb?: {
      targetGroupArn?: string;
    };
  };
}

/** The event of an API Gateway HTTP API on payload format 2.0 and of a Lambda Function URL */
export interface LambdaHttpApiEvent {
  version: '2.0';
  routeKey?: string;
  rawPath: string;
  rawQueryString?: string;
  /** The request's cookies, one `name=value` per entry (they are not in `headers`) */
  cookies?: string[];
  headers?: Record<string, string> | null;
  queryStringParameters?: Record<string, string> | null;
  pathParameters?: Record<string, string> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
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
  /** Set-Cookie values, for an event on payload format 2.0 */
  cookies?: string[];
  body: string;
  isBase64Encoded?: boolean;
}

function isHttpApiEvent(event: LambdaEvent | LambdaHttpApiEvent): event is LambdaHttpApiEvent {
  return (
    (event as LambdaHttpApiEvent).version === '2.0' &&
    (event as LambdaHttpApiEvent).rawPath !== undefined
  );
}

// A REST API hands header names over in the client's casing, so a handler
// reading req.headers.authorization finds nothing when `Authorization` was
// sent. Every name is made reachable in lower case as well, as on every other
// runtime; the names as received stay. The event's own object is left alone:
// headers that are all lower case already are returned as they are.
function withLowerCaseNames(headers: Record<string, string>): Record<string, string> {
  let all = headers;
  for (const name in headers) {
    const lower = lowerCaseName(name);
    if (lower !== name && headers[lower] === undefined) {
      if (all === headers) all = { ...headers };
      all[lower] = headers[name] as string;
    }
  }
  return all;
}

// Header names repeat from one invocation to the next: each is lower-cased once
const lowerCaseNames = new Map<string, string>();
function lowerCaseName(name: string): string {
  let lower = lowerCaseNames.get(name);
  if (lower === undefined) {
    lower = name.toLowerCase();
    if (lowerCaseNames.size < 512) lowerCaseNames.set(name, lower);
  }
  return lower;
}

// That is work per header, and many requests are answered without a look at
// req.headers. So it is done when req.headers is first read: until then the
// request holds the event's headers as they are.
const EVENT_HEADERS = Symbol('headers as received');
const ALL_HEADERS = Symbol('headers');
const headersOnFirstRead: PropertyDescriptor = {
  enumerable: true,
  configurable: true,
  get(this: any): Record<string, string> {
    return this[ALL_HEADERS] ?? (this[ALL_HEADERS] = withLowerCaseNames(this[EVENT_HEADERS]));
  },
  set(this: any, headers: Record<string, string>) {
    this[ALL_HEADERS] = headers;
  },
};

// console.log(req) / util.inspect(req) show the request as the plain object
// it reads as: the headers themselves, not the accessor and what is behind it
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
function inspectRequest(this: Record<string, unknown>): Record<string, unknown> {
  const shown: Record<string, unknown> = {};
  for (const key of Object.keys(this)) shown[key] = this[key];
  return shown;
}

// The Cookie header of a REST API event, under the spellings clients send:
// `cookie` (HTTP/2, load balancers), `Cookie` (browsers over HTTP/1.1) and
// `COOKIE`. Three lookups, so req.cookies never costs a pass over the headers.
function cookieHeaderOf(headers: Record<string, string>): string {
  return headers.cookie || headers.Cookie || headers.COOKIE || '';
}

// One value per header, names in lower case as well: repeated values are
// joined the way a single-value event carries them
function singleValueHeaders(multiValueHeaders: Record<string, string[]>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name in multiValueHeaders) {
    const values = multiValueHeaders[name];
    if (!values || values.length === 0) continue;
    const lower = name.toLowerCase();
    const value =
      values.length === 1 ? (values[0] as string) : values.join(lower === 'cookie' ? '; ' : ', ');
    headers[name] = value;
    if (lower !== name && headers[lower] === undefined) headers[lower] = value;
  }
  return headers;
}

// The query string of a REST API or load balancer event, for req.url. These
// events name the path alone and deliver the query as parameters; req.url
// carries it, as on every other runtime. Every value of a repeated parameter
// is there, in the order given.
//
// API Gateway hands names and values over URL-decoded, so they are encoded
// again here. A load balancer hands them over as the client sent them, still
// percent-encoded: those are written as they are.
function queryStringOf(event: LambdaEvent): string {
  const asSent = event.requestContext?.elb !== undefined;
  let search = '';
  const multiValue = event.multiValueQueryStringParameters;
  if (multiValue) {
    for (const name in multiValue) {
      const values = multiValue[name];
      if (!values) continue;
      const key = asSent ? name : queryText(name);
      for (let i = 0; i < values.length; i++) {
        const value = values[i] as string;
        if (search !== '') search += '&';
        search += key + '=' + (asSent ? value : queryText(value));
      }
    }
    if (search !== '') return search;
  }
  const singleValue = event.queryStringParameters;
  if (singleValue) {
    for (const name in singleValue) {
      const value = singleValue[name] as string;
      if (search !== '') search += '&';
      search += asSent ? name + '=' + value : queryText(name) + '=' + queryText(value);
    }
  }
  return search;
}

// Most names and values are plain words and numbers, which stand in a query
// string as they are
const NOT_PLAIN = /[^A-Za-z0-9_.~-]/;
function queryText(text: string): string {
  return NOT_PLAIN.test(text) ? encodeURIComponent(text) : text;
}

function withoutHeader(headers: Record<string, string>, key: string): Record<string, string> {
  const rest: Record<string, string> = {};
  for (const name in headers) {
    if (name !== key) rest[name] = headers[name] as string;
  }
  return rest;
}

export class AWSLambdaAdapter extends BaseRuntimeAdapter {
  readonly type = 'aws-lambda' as const;

  // A function is reached only through the platform (API Gateway, a Function
  // URL, a load balancer), which writes X-Forwarded-Proto itself: the scheme
  // the client used to reach it
  protected override requestOverTls(request: HttpRequest): boolean {
    const headers = request.headers as Record<string, string | undefined> | undefined;
    return headers !== undefined && firstForwarded(headers['x-forwarded-proto']) === 'https';
  }

  async adaptRequest(
    event: LambdaEvent | LambdaHttpApiEvent,
    context: LambdaContext
  ): Promise<HttpRequest> {
    if (isHttpApiEvent(event)) return this.adaptHttpApiRequest(event, context);

    const { pathname, query } = this.parseUrl(event.path);

    // Merge query parameters from event. API Gateway hands them over decoded:
    // they are req.query as they are. A load balancer hands them over as the
    // client sent them, still percent-encoded: its req.query is parsed further
    // down, from the query string they make.
    const eventQueryParams = event.queryStringParameters;
    const fromLoadBalancer = event.requestContext?.elb !== undefined;
    let mergedQuery =
      eventQueryParams && !fromLoadBalancer ? Object.assign({}, query, eventQueryParams) : query;

    const eventHeaders = event.headers;
    // Set when the request gets its headers ready-made; a REST API event's
    // headers are prepared on first read instead
    let headers: Record<string, string> | undefined;
    let ip = event.requestContext?.identity?.sourceIp || 'unknown';
    let contentType: string | undefined;
    let cookieHeader: string;
    if (eventHeaders) {
      // The body is parsed by the Content-Type as the event names it
      if (event.body) contentType = eventHeaders['content-type'] || eventHeaders['Content-Type'];
      cookieHeader = cookieHeaderOf(eventHeaders);
    } else if (event.multiValueHeaders) {
      // A load balancer with multi-value headers enabled: no single-value fields
      headers = singleValueHeaders(event.multiValueHeaders);
      contentType = headers['content-type'];
      cookieHeader = headers.cookie || '';
      const multiValueQuery = event.multiValueQueryStringParameters;
      if (!eventQueryParams && multiValueQuery && !fromLoadBalancer) {
        mergedQuery = Object.assign({}, query);
        for (const name in multiValueQuery) {
          const values = multiValueQuery[name];
          // The last value of a repeated parameter, as in queryStringParameters
          if (values && values.length > 0) mergedQuery[name] = values[values.length - 1] as string;
        }
      }
      if (ip === 'unknown' && event.requestContext?.elb) {
        // The load balancer appends the address it accepted the connection
        // from; anything before it was sent by the client
        const forwarded = headers['x-forwarded-for'];
        if (forwarded) ip = forwarded.substring(forwarded.lastIndexOf(',') + 1).trim() || ip;
      }
    } else {
      headers = {};
      cookieHeader = '';
    }

    // Parse body
    let body: any;
    if (event.body) {
      if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString();
      } else {
        body = event.body;
      }
      body = await this.parseBody(body, contentType || '');
    }

    // req.url is the path with its query string. An event without query
    // parameters has nothing to add.
    const search =
      eventQueryParams || event.multiValueQueryStringParameters ? queryStringOf(event) : '';
    // A path that brings a query string of its own keeps it in front
    const pathHasQuery = search !== '' && event.path.includes('?');
    const url = search === '' ? event.path : `${event.path}${pathHasQuery ? '&' : '?'}${search}`;
    // A load balancer's parameters, decoded by the parser the servers use:
    // req.query is what the Node.js server gives for the same request line
    if (fromLoadBalancer && search !== '') {
      mergedQuery = parseRawQueryString(
        pathHasQuery ? url.substring(url.indexOf('?') + 1) : search
      );
    }

    // Built in this order so the request's keys read as they always did
    const baseRequest: any = {
      method: event.httpMethod,
      url,
      path: pathname,
      query: mergedQuery,
      body,
    };
    if (headers === undefined) {
      Object.defineProperty(baseRequest, 'headers', headersOnFirstRead);
    } else {
      baseRequest.headers = headers;
    }
    baseRequest.ip = ip;
    baseRequest.params = event.pathParameters || {};
    baseRequest.requestId = context.awsRequestId;
    baseRequest.cookies = parseCookieHeader(cookieHeader);
    baseRequest.files = {};
    // The invocation's context object (awsRequestId, functionName, ...)
    baseRequest.context = context;
    if (headers === undefined) {
      baseRequest[EVENT_HEADERS] = eventHeaders;
      baseRequest[INSPECT] = inspectRequest;
    }

    return this.enhanceRequest(baseRequest as Partial<HttpRequest>);
  }

  // HTTP API payload format 2.0 / Function URL: the path and the query string
  // arrive raw, the method sits in requestContext.http, header names are
  // already lower case and the cookies come as a list of their own.
  private async adaptHttpApiRequest(
    event: LambdaHttpApiEvent,
    context: LambdaContext
  ): Promise<HttpRequest> {
    const url = event.rawQueryString ? `${event.rawPath}?${event.rawQueryString}` : event.rawPath;
    const { pathname, query } = this.parseUrl(url);
    const http = event.requestContext?.http;

    let headers = event.headers || {};
    let cookieHeader = headers.cookie || '';
    if (event.cookies && event.cookies.length > 0) {
      cookieHeader = event.cookies.join('; ');
      headers = Object.assign({}, headers, { cookie: cookieHeader });
    }

    let body: any;
    if (event.body) {
      body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
      body = await this.parseBody(body, headers['content-type'] || '');
    }

    const baseRequest = {
      method: http?.method as string,
      url,
      path: pathname,
      query,
      body,
      headers,
      ip: http?.sourceIp || 'unknown',
      params: event.pathParameters || {},
      requestId: context.awsRequestId,
      cookies: parseCookieHeader(cookieHeader),
      files: {},
      context,
    } as Partial<HttpRequest>;

    return this.enhanceRequest(baseRequest);
  }

  /**
   * The response object Lambda returns to the platform. `event` is the event
   * being answered: it decides where the platform reads headers and cookies
   * from. Without it the answer has the REST API shape.
   */
  async adaptResponse(
    moroResponse: HttpResponse | RuntimeHttpResponse,
    event?: LambdaEvent | LambdaHttpApiEvent
  ): Promise<LambdaResponse> {
    const runtimeResponse = moroResponse as RuntimeHttpResponse;

    let body = runtimeResponse.body;
    const status = runtimeResponse.statusCode || 200;
    const headers = runtimeResponse.headers || {};
    let isBase64Encoded = false;

    // Convert body to string
    if (typeof body === 'object' && body !== null) {
      const bytes = bytesOf(body);
      if (bytes !== undefined) {
        // Bytes travel base64-encoded, under the type the handler set
        body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
        isBase64Encoded = true;
        if (headerKeyOf(headers, 'content-type') === undefined) {
          headers['Content-Type'] = 'application/octet-stream';
        }
      } else {
        body = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
    } else if (body === null || body === undefined) {
      body = '';
    } else {
      body = String(body);
    }

    const response: LambdaResponse = {
      statusCode: status,
      headers,
      body,
      isBase64Encoded,
    };

    const cookies = multipleCookiesOf(moroResponse);
    if (event !== undefined && isHttpApiEvent(event)) {
      // Payload format 2.0 reads cookies from `cookies`, never from a header
      const key = headerKeyOf(headers, 'set-cookie');
      if (key !== undefined) {
        const single: string | string[] = headers[key] as string | string[];
        response.cookies = cookies ?? (Array.isArray(single) ? single : [single]);
        response.headers = withoutHeader(headers, key);
      }
    } else if (event !== undefined && !event.headers && event.multiValueHeaders) {
      // A load balancer with multi-value headers enabled reads every header
      // from multiValueHeaders and nothing from `headers`
      const multiValueHeaders: Record<string, string[]> = {};
      const cookieKey = cookies !== undefined ? headerKeyOf(headers, 'set-cookie') : undefined;
      for (const name in headers) {
        const value: string | string[] = headers[name] as string | string[];
        multiValueHeaders[name] =
          name === cookieKey ? (cookies as string[]) : Array.isArray(value) ? value : [value];
      }
      response.multiValueHeaders = multiValueHeaders;
    } else if (cookies !== undefined) {
      // REST API: one Set-Cookie per cookie needs multiValueHeaders. A load
      // balancer without multi-value headers reads `headers` only and can carry
      // a single Set-Cookie, so the latest cookie stays there for it.
      const key = headerKeyOf(headers, 'set-cookie') as string;
      response.multiValueHeaders = { [key]: cookies };
      if (!event?.requestContext?.elb) response.headers = withoutHeader(headers, key);
    }

    return response;
  }

  createServer(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>) {
    // Return a Lambda-compatible handler function
    return async (event: LambdaEvent | LambdaHttpApiEvent, context: LambdaContext) => {
      try {
        const moroReq = await this.adaptRequest(event, context);
        const moroRes = this.createMockResponse(moroReq);

        await handler(moroReq, moroRes as any);
        finishResponse(moroRes);

        return await this.adaptResponse(moroRes, event);
      } catch (error) {
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: handlerFailureBody(error, context?.awsRequestId),
        };
      }
    };
  }

  // Lambda doesn't have a listen method - it's event-driven
  // listen method is optional in the interface
}
