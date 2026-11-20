/* eslint-disable */
// Runtime Adapters Unit Tests
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import {
  NodeRuntimeAdapter,
  VercelEdgeAdapter,
  AWSLambdaAdapter,
  CloudflareWorkersAdapter,
  createRuntimeAdapter,
} from '../../../src/core/runtime/index.js';
import type {
  LambdaEvent,
  LambdaHttpApiEvent,
  LambdaContext,
  LambdaResponse,
  WorkersEnv,
  WorkersContext,
} from '../../../src/core/runtime/index.js';
import { runtimeLogger } from '../../../src/core/runtime/base-adapter.js';
import { IncomingMessage, ServerResponse } from 'http';
import { inspect } from 'util';
import {
  createApp,
  createAppLambda,
  createAppEdge,
  createAppWorker,
  auth,
  createAuthMiddleware,
  requireAuth,
} from '../../../src/index.js';
import { forgetStartupWarnings } from '../../../src/core/auth/morojs-adapter.js';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { compression } from '../../../src/core/middleware/built-in/compression/index.js';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../../setup.js';
import { setCookies, secureFlags, OVER_HTTP, OVER_TLS } from '../../utils/cookie-secure-parity.js';
import {
  registerSyntaxRoutes,
  SYNTAX_CASES,
  describeReply,
  collectAnswers,
  expectedAnswers,
} from '../../utils/route-syntax-parity.js';
import { MoroHttpServer, MoroServerResponse } from '../../../src/core/http/http-server.js';
import nodeHttp from 'node:http';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Runtime Adapters', () => {
  describe('createRuntimeAdapter factory', () => {
    it('should create Node.js adapter', () => {
      const adapter = createRuntimeAdapter('node');
      expect(adapter).toBeInstanceOf(NodeRuntimeAdapter);
      expect(adapter.type).toBe('node');
    });

    it('should create Vercel Edge adapter', () => {
      const adapter = createRuntimeAdapter('vercel-edge');
      expect(adapter).toBeInstanceOf(VercelEdgeAdapter);
      expect(adapter.type).toBe('vercel-edge');
    });

    it('should create AWS Lambda adapter', () => {
      const adapter = createRuntimeAdapter('aws-lambda');
      expect(adapter).toBeInstanceOf(AWSLambdaAdapter);
      expect(adapter.type).toBe('aws-lambda');
    });

    it('should create Cloudflare Workers adapter', () => {
      const adapter = createRuntimeAdapter('cloudflare-workers');
      expect(adapter).toBeInstanceOf(CloudflareWorkersAdapter);
      expect(adapter.type).toBe('cloudflare-workers');
    });

    it('should throw error for unsupported runtime', () => {
      expect(() => createRuntimeAdapter('invalid' as any)).toThrow(
        'Unsupported runtime type: invalid'
      );
    });
  });

  describe('NodeRuntimeAdapter', () => {
    let adapter: NodeRuntimeAdapter;

    beforeEach(() => {
      adapter = new NodeRuntimeAdapter();
    });

    it('should have correct type', () => {
      expect(adapter.type).toBe('node');
    });

    it('should adapt Node.js request', async () => {
      const mockReq = {
        method: 'GET',
        url: '/api/test?param=value',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.168.1.1' },
        socket: { remoteAddress: '127.0.0.1' },
        on: jest.fn(),
        httpVersion: '1.1',
        httpVersionMajor: 1,
        httpVersionMinor: 1,
      } as any;

      // Mock the body parsing for GET request (no body)
      const adaptedReq = await adapter.adaptRequest(mockReq);

      expect(adaptedReq.method).toBe('GET');
      expect(adaptedReq.path).toBe('/api/test');
      expect(adaptedReq.query).toEqual({ param: 'value' });
      expect(adaptedReq.headers).toEqual(mockReq.headers);
      expect(adaptedReq.ip).toBe('192.168.1.1');
      expect(adaptedReq.requestId).toBeDefined();
      expect(adaptedReq.params).toEqual({});
    });

    it('should create HTTP server', () => {
      const mockHandler = jest.fn(async (req: any, res: any) => {});
      const server = adapter.createServer(mockHandler);

      expect(server).toBeDefined();
      expect(typeof server.listen).toBe('function');
    });

    // res.sendFile() answers the same whichever way a Node response reaches
    // the handler: on the Node server, through app.getHandler(), and on a
    // response that is not of the server's own class.
    describe('res.sendFile()', () => {
      let dir: string;
      const closers: Array<() => Promise<unknown>> = [];

      beforeAll(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moro-node-runtime-'));
        await fsp.mkdir(path.join(dir, 'public'));
        await fsp.writeFile(path.join(dir, 'public', 'small.txt'), 'a small file\n');
        await fsp.writeFile(path.join(dir, 'public', 'large.bin'), Buffer.alloc(200 * 1024, 7));
        await fsp.writeFile(path.join(dir, 'outside.txt'), 'not under the root\n');
      });

      afterAll(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
      });

      afterEach(async () => {
        for (const close of closers.splice(0)) await close();
        resetConfig();
      });

      const FILES: Record<string, (res: any) => unknown> = {
        '/small': res =>
          res.sendFile(path.join(dir, 'public', 'small.txt'), { maxAge: 60, immutable: true }),
        '/large': res =>
          res.sendFile(path.join(dir, 'public', 'large.bin'), {
            cacheControl: 'private, max-age=5',
          }),
        '/missing': res => res.sendFile(path.join(dir, 'public', 'absent.txt')),
        '/escape': res => res.sendFile('../outside.txt', { root: path.join(dir, 'public') }),
      };

      const fetchFile = (port: number, target: string) =>
        new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>(
          (resolve, reject) => {
            nodeHttp
              .get({ host: '127.0.0.1', port, path: target, agent: false }, res => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(chunk as Buffer));
                res.on('end', () =>
                  resolve({
                    status: res.statusCode as number,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                  })
                );
              })
              .on('error', reject);
          }
        );

      // What a client can tell one answer from another by
      const answers = async (port: number) => {
        const seen: Record<string, unknown> = {};
        for (const target of Object.keys(FILES)) {
          const reply = await fetchFile(port, target);
          const file = reply.status === 200;
          seen[target] = {
            status: reply.status,
            bytes: reply.body.length,
            body: file ? reply.body.toString('hex').slice(0, 64) : JSON.parse(String(reply.body)),
            type: file ? reply.headers['content-type'] : undefined,
            length: file ? reply.headers['content-length'] : undefined,
            cacheControl: reply.headers['cache-control'],
            lastModified: reply.headers['last-modified'],
            nosniff: reply.headers['x-content-type-options'],
          };
        }
        return seen;
      };

      const bootApp = async (viaHandler: boolean) => {
        resetConfig();
        UnifiedRouter.reset();
        const app: any = await createApp({
          logger: { level: 'fatal' },
          autoDiscover: false,
          server: { engine: 'node' },
        } as any);
        for (const [target, send] of Object.entries(FILES)) {
          app.get(target, (_req: any, res: any) => send(res));
        }
        const server = viaHandler ? app.getHandler() : app.core.httpServer;
        if (viaHandler) {
          await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
          closers.push(() => new Promise(resolve => server.getServer().close(resolve)));
        } else {
          await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
        }
        closers.push(() => closeApp(app));
        return (server.getServer().address() as any).port as number;
      };

      const expected = () => ({
        '/small': expect.objectContaining({
          status: 200,
          bytes: 13,
          type: 'text/plain; charset=utf-8',
          cacheControl: 'public, max-age=60, immutable',
          nosniff: 'nosniff',
        }),
        '/large': expect.objectContaining({
          status: 200,
          bytes: 200 * 1024,
          length: String(200 * 1024),
          cacheControl: 'private, max-age=5',
        }),
        '/missing': expect.objectContaining({
          status: 404,
          body: { success: false, error: 'File not found' },
        }),
        '/escape': expect.objectContaining({
          status: 404,
          body: { success: false, error: 'File not found' },
        }),
      });

      it('answers through app.getHandler() as the Node server does', async () => {
        const onServer = await answers(await bootApp(false));
        const throughHandler = await answers(await bootApp(true));

        expect(onServer).toEqual(expected());
        expect(throughHandler).toEqual(onServer);
      });

      it('answers on a plain Node response as the Node server does', async () => {
        const onServer = await answers(await bootApp(false));

        // A response of Node's own class, given the response helpers by the
        // adapter: nothing here comes from the server's response class.
        const owner = adapter.createServer(async () => {});
        const plain = nodeHttp.createServer((req, res) => {
          expect(res).not.toBeInstanceOf(MoroServerResponse);
          const enhanced = (adapter as any).enhanceResponse(res, owner);
          void (FILES[req.url as string] as (res: any) => unknown)(enhanced);
        });
        await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', () => resolve()));
        closers.push(() => new Promise(resolve => plain.close(resolve)));

        const onPlain = await answers((plain.address() as any).port);
        expect(onPlain).toEqual(onServer);
      });
    });
  });

  describe('VercelEdgeAdapter', () => {
    let adapter: VercelEdgeAdapter;

    beforeEach(() => {
      adapter = new VercelEdgeAdapter();
    });

    it('should have correct type', () => {
      expect(adapter.type).toBe('vercel-edge');
    });

    it('should adapt Vercel Edge request', async () => {
      const mockRequest = new Request('https://example.com/api/test?param=value', {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
      });

      const adaptedReq = await adapter.adaptRequest(mockRequest);

      expect(adaptedReq.method).toBe('GET');
      expect(adaptedReq.path).toBe('/api/test');
      expect(adaptedReq.query).toEqual({ param: 'value' });
      expect(adaptedReq.ip).toBe('192.168.1.1');
      expect(adaptedReq.requestId).toBeDefined();
    });

    it('should adapt POST request with JSON body', async () => {
      const body = { test: 'data' };
      const mockRequest = new Request('https://example.com/api/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const adaptedReq = await adapter.adaptRequest(mockRequest);

      expect(adaptedReq.method).toBe('POST');
      expect(adaptedReq.body).toEqual(body);
    });

    it('should parse the Cookie header', async () => {
      const mockRequest = new Request('https://example.com/api/test', {
        headers: { cookie: 'sid=abc%20d; theme=dark' },
      });

      const adaptedReq = await adapter.adaptRequest(mockRequest);

      // Values are decoded, as on the Node server
      expect(adaptedReq.cookies).toEqual({ sid: 'abc d', theme: 'dark' });
    });

    it('should create Edge handler', () => {
      const mockHandler = jest.fn(async (req: any, res: any) => {});
      const handler = adapter.createServer(mockHandler);

      expect(typeof handler).toBe('function');
    });

    it('should adapt response to Web Response', async () => {
      const mockResponse = {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { message: 'success' },
      } as any;

      const webResponse = await adapter.adaptResponse(mockResponse);

      expect(webResponse).toBeInstanceOf(Response);
      expect(webResponse.status).toBe(200);
      expect(webResponse.headers.get('Content-Type')).toBe('application/json');

      const responseBody = await webResponse.json();
      expect(responseBody).toEqual({ message: 'success' });
    });
  });

  describe('AWSLambdaAdapter', () => {
    let adapter: AWSLambdaAdapter;

    beforeEach(() => {
      adapter = new AWSLambdaAdapter();
    });

    it('should have correct type', () => {
      expect(adapter.type).toBe('aws-lambda');
    });

    it('should adapt Lambda event', async () => {
      const mockEvent: LambdaEvent = {
        httpMethod: 'GET',
        path: '/api/test',
        queryStringParameters: { param: 'value' },
        headers: { 'Content-Type': 'application/json' },
        pathParameters: { id: '123' },
        body: null,
        requestContext: {
          identity: { sourceIp: '192.168.1.1' },
        },
      };

      const mockContext: LambdaContext = {
        requestId: 'test-request-id',
        awsRequestId: 'aws-123',
        functionName: 'test-function',
        functionVersion: '1',
        invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test',
        memoryLimitInMB: '128',
        logGroupName: '/aws/lambda/test',
        logStreamName: '2023/01/01/[$LATEST]abc123',
        getRemainingTimeInMillis: () => 30000,
      };

      const adaptedReq = await adapter.adaptRequest(mockEvent, mockContext);

      expect(adaptedReq.method).toBe('GET');
      expect(adaptedReq.path).toBe('/api/test');
      expect(adaptedReq.query).toEqual({ param: 'value' });
      expect(adaptedReq.params).toEqual({ id: '123' });
      expect(adaptedReq.ip).toBe('192.168.1.1');
      expect(adaptedReq.requestId).toBe('aws-123');
    });

    it('should handle POST request with body', async () => {
      const body = { test: 'data' };
      const mockEvent: LambdaEvent = {
        httpMethod: 'POST',
        path: '/api/post',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        queryStringParameters: null,
        pathParameters: null,
      };

      const mockContext: LambdaContext = {
        awsRequestId: 'aws-123',
        getRemainingTimeInMillis: () => 30000,
      } as any;

      const adaptedReq = await adapter.adaptRequest(mockEvent, mockContext);

      expect(adaptedReq.method).toBe('POST');
      expect(adaptedReq.body).toEqual(body);
    });

    const lambdaContext = {
      awsRequestId: 'aws-123',
      functionName: 'test-function',
      getRemainingTimeInMillis: () => 30000,
    } as any as LambdaContext;

    it('should keep a REST API event with lower-case header names as it is', async () => {
      const headers = {
        host: 'api.example.com',
        'content-type': 'application/json',
        cookie: 'sid=abc%20d; theme=dark',
      };
      const mockEvent: LambdaEvent = {
        httpMethod: 'POST',
        path: '/api/items',
        headers,
        queryStringParameters: { page: '2' },
        pathParameters: null,
        body: '{"name":"a"}',
        isBase64Encoded: false,
        requestContext: { identity: { sourceIp: '203.0.113.9' } },
      };

      const adaptedReq = await adapter.adaptRequest(mockEvent, lambdaContext);

      expect(Object.keys(adaptedReq)).toEqual([
        'method',
        'url',
        'path',
        'query',
        'body',
        'headers',
        'ip',
        'params',
        'requestId',
        'cookies',
        'files',
        'context',
      ]);
      // The event's own header object: nothing copied, nothing added
      expect(adaptedReq.headers).toBe(headers);
      expect(Object.keys(headers)).toEqual(['host', 'content-type', 'cookie']);
      expect(adaptedReq).toMatchObject({
        method: 'POST',
        // The path with its query string, as on every other runtime
        url: '/api/items?page=2',
        path: '/api/items',
        query: { page: '2' },
        body: { name: 'a' },
        ip: '203.0.113.9',
        params: {},
        requestId: 'aws-123',
        cookies: { sid: 'abc d', theme: 'dark' },
        files: {},
      });
    });

    it('should make header names sent in upper case readable in lower case too', async () => {
      const headers = {
        Host: 'api.example.com',
        Authorization: 'Bearer token',
        'X-Api-Key': 'key',
        accept: '*/*',
      };
      const mockEvent: LambdaEvent = { httpMethod: 'GET', path: '/api/test', headers };

      const adaptedReq = await adapter.adaptRequest(mockEvent, lambdaContext);

      expect(adaptedReq.headers.authorization).toBe('Bearer token');
      expect(adaptedReq.headers['x-api-key']).toBe('key');
      // The names as sent stay, and the event is not written to
      expect(adaptedReq.headers).toEqual({
        ...headers,
        host: 'api.example.com',
        authorization: 'Bearer token',
        'x-api-key': 'key',
      });
      expect(Object.keys(headers)).toEqual(['Host', 'Authorization', 'X-Api-Key', 'accept']);
      expect(JSON.parse(JSON.stringify(adaptedReq)).headers).toEqual(adaptedReq.headers);
      expect({ ...adaptedReq }.headers).toEqual(adaptedReq.headers);

      // A handler may still replace them
      adaptedReq.headers = { replaced: 'yes' };
      expect(adaptedReq.headers).toEqual({ replaced: 'yes' });
    });

    it('should show the headers when the request is logged', async () => {
      const mockEvent: LambdaEvent = {
        httpMethod: 'GET',
        path: '/api/test',
        headers: { Authorization: 'Bearer token' },
      };

      const adaptedReq = await adapter.adaptRequest(mockEvent, lambdaContext);
      const logged = inspect(adaptedReq);

      expect(logged).toContain(
        "headers: { Authorization: 'Bearer token', authorization: 'Bearer token' }"
      );
      expect(logged).not.toMatch(/Getter|Symbol\(/);
      expect(logged.startsWith("{\n  method: 'GET',")).toBe(true);
    });

    it('should parse the Cookie header sent as cookie, Cookie or COOKIE', async () => {
      for (const name of ['cookie', 'Cookie', 'COOKIE']) {
        const mockEvent: LambdaEvent = {
          httpMethod: 'GET',
          path: '/api/test',
          headers: { [name]: 'sid=abc%20d; theme=dark' },
        };

        const adaptedReq = await adapter.adaptRequest(mockEvent, lambdaContext);

        expect({ name, cookies: adaptedReq.cookies }).toEqual({
          name,
          cookies: { sid: 'abc d', theme: 'dark' },
        });
      }
    });

    it('should read path and query from the event path the way the URL parser does', async () => {
      const cases: Array<[string, string, Record<string, string>]> = [
        ['/', '/', {}],
        ['/api/users/42', '/api/users/42', {}],
        ['/files/report.v2.json', '/files/report.v2.json', {}],
        ['/api/test?a=1&b=two', '/api/test', { a: '1', b: 'two' }],
        ['/a/../b', '/b', {}],
        ['/a/./b', '/a/b', {}],
        ['/files/a%20b.txt', '/files/a%20b.txt', {}],
        ['/files/a b.txt', '/files/a%20b.txt', {}],
        ['/.well-known/x', '/.well-known/x', {}],
        ['/a//b', '/a//b', {}],
        ['/a#frag', '/a', {}],
      ];

      for (const [path, pathname, query] of cases) {
        const adaptedReq = await adapter.adaptRequest(
          { httpMethod: 'GET', path, headers: {} },
          lambdaContext
        );

        expect({ path, pathname: adaptedReq.path, query: adaptedReq.query }).toEqual({
          path,
          pathname,
          query,
        });
        expect(adaptedReq.url).toBe(path);
      }
    });

    it('should hand malformed JSON and urlencoded bodies to the handler as text', async () => {
      const malformed = await adapter.adaptRequest(
        {
          httpMethod: 'POST',
          path: '/api/post',
          headers: { 'content-type': 'application/json' },
          body: '{"a":',
        },
        lambdaContext
      );
      expect(malformed.body).toBe('{"a":');

      const form = await adapter.adaptRequest(
        {
          httpMethod: 'POST',
          path: '/api/post',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'a=1&b=2',
        },
        lambdaContext
      );
      expect(form.body).toBe('a=1&b=2');
    });

    it('should expose the invocation context as req.context', async () => {
      const adaptedReq = await adapter.adaptRequest(
        { httpMethod: 'GET', path: '/api/info', headers: {} },
        lambdaContext
      );

      expect(adaptedReq.context).toBe(lambdaContext);
      expect(adaptedReq.context.functionName).toBe('test-function');
      expect(adaptedReq.context.getRemainingTimeInMillis()).toBe(30000);
    });

    describe('HTTP API payload format 2.0 and Function URL events', () => {
      const httpApiEvent = (extra: Partial<LambdaHttpApiEvent> = {}): LambdaHttpApiEvent => ({
        version: '2.0',
        routeKey: '$default',
        rawPath: '/api/items/7',
        rawQueryString: 'tag=a&tag=b&q=x%20y',
        cookies: ['sid=abc%20d', 'theme=dark'],
        headers: { host: 'abc.lambda-url.eu-west-1.on.aws', authorization: 'Bearer token' },
        requestContext: {
          http: { method: 'GET', path: '/api/items/7', sourceIp: '203.0.113.9' },
        },
        isBase64Encoded: false,
        ...extra,
      });

      it('should adapt the event', async () => {
        const adaptedReq = await adapter.adaptRequest(httpApiEvent(), lambdaContext);

        expect(adaptedReq).toMatchObject({
          method: 'GET',
          url: '/api/items/7?tag=a&tag=b&q=x%20y',
          path: '/api/items/7',
          // The last value of a repeated parameter, as on the other runtimes
          query: { tag: 'b', q: 'x y' },
          ip: '203.0.113.9',
          requestId: 'aws-123',
          cookies: { sid: 'abc d', theme: 'dark' },
        });
        expect(adaptedReq.headers).toEqual({
          host: 'abc.lambda-url.eu-west-1.on.aws',
          authorization: 'Bearer token',
          cookie: 'sid=abc%20d; theme=dark',
        });
      });

      it('should parse a JSON body, base64-encoded or not', async () => {
        const headers = { 'content-type': 'application/json' };
        const plain = await adapter.adaptRequest(
          httpApiEvent({
            headers,
            body: '{"a":1}',
            requestContext: { http: { method: 'POST' } },
          }),
          lambdaContext
        );
        const encoded = await adapter.adaptRequest(
          httpApiEvent({
            headers,
            body: Buffer.from('{"a":1}').toString('base64'),
            isBase64Encoded: true,
            requestContext: { http: { method: 'POST' } },
          }),
          lambdaContext
        );

        expect(plain.method).toBe('POST');
        expect(plain.body).toEqual({ a: 1 });
        expect(encoded.body).toEqual({ a: 1 });
      });

      it('should reach the handler and answer with cookies in `cookies`', async () => {
        const seen: string[] = [];
        const handler = adapter.createServer(async (req: any, res: any) => {
          seen.push(`${req.method} ${req.path}`);
          res.cookie('sid', 'abc');
          res.cookie('theme', 'dark');
          res.setHeader('X-One', '1');
          res.json({ ok: true });
        });

        const result = await handler(httpApiEvent(), lambdaContext);

        expect(seen).toEqual(['GET /api/items/7']);
        expect(result).toEqual({
          statusCode: 200,
          headers: { 'X-One': '1', 'Content-Type': 'application/json' },
          cookies: ['sid=abc; Path=/', 'theme=dark; Path=/'],
          body: '{"ok":true}',
          isBase64Encoded: false,
        });
      });

      it('should answer with a single cookie in `cookies` too', async () => {
        const handler = adapter.createServer(async (_req: any, res: any) => {
          res.cookie('sid', 'abc');
          res.json({ ok: true });
        });

        const result = (await handler(httpApiEvent(), lambdaContext)) as LambdaResponse;

        expect(result.cookies).toEqual(['sid=abc; Path=/']);
        expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
      });
    });

    describe('Application Load Balancer events with multi-value headers', () => {
      const albEvent = (): LambdaEvent => ({
        httpMethod: 'POST',
        path: '/api/items',
        multiValueHeaders: {
          host: ['alb.example.com'],
          'content-type': ['application/json'],
          accept: ['text/html', 'application/json'],
          cookie: ['sid=abc', 'theme=dark'],
          'x-forwarded-for': ['198.51.100.7, 203.0.113.9'],
        },
        multiValueQueryStringParameters: { tag: ['a', 'b'], page: ['2'] },
        body: '{"name":"a"}',
        isBase64Encoded: false,
        requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:tg' } },
      });

      it('should adapt the event', async () => {
        const adaptedReq = await adapter.adaptRequest(albEvent(), lambdaContext);

        expect(adaptedReq.headers).toEqual({
          host: 'alb.example.com',
          'content-type': 'application/json',
          accept: 'text/html, application/json',
          cookie: 'sid=abc; theme=dark',
          'x-forwarded-for': '198.51.100.7, 203.0.113.9',
        });
        expect(adaptedReq.query).toEqual({ tag: 'b', page: '2' });
        expect(adaptedReq.cookies).toEqual({ sid: 'abc', theme: 'dark' });
        expect(adaptedReq.body).toEqual({ name: 'a' });
        // The address the load balancer appended, not one the client wrote
        expect(adaptedReq.ip).toBe('203.0.113.9');
      });

      it('should answer with every header in multiValueHeaders', async () => {
        const handler = adapter.createServer(async (_req: any, res: any) => {
          res.cookie('sid', 'abc');
          res.cookie('theme', 'dark');
          res.status(201).json({ ok: true });
        });

        const result = (await handler(albEvent(), lambdaContext)) as LambdaResponse;

        expect(result.statusCode).toBe(201);
        expect(result.multiValueHeaders).toEqual({
          'Set-Cookie': ['sid=abc; Path=/', 'theme=dark; Path=/'],
          'Content-Type': ['application/json'],
        });
        expect(result.body).toBe('{"ok":true}');
      });
    });

    it('should create Lambda handler', () => {
      const mockHandler = jest.fn(async (req: any, res: any) => {});
      const handler = adapter.createServer(mockHandler);

      expect(typeof handler).toBe('function');
    });

    it('should adapt response to Lambda response', async () => {
      const mockResponse = {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: { id: 1, name: 'test' },
      } as any;

      const lambdaResponse = await adapter.adaptResponse(mockResponse);

      expect(lambdaResponse.statusCode).toBe(201);
      expect(lambdaResponse.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(lambdaResponse.body).toBe('{"id":1,"name":"test"}');
      expect(lambdaResponse.isBase64Encoded).toBe(false);
    });
  });

  describe('CloudflareWorkersAdapter', () => {
    let adapter: CloudflareWorkersAdapter;

    beforeEach(() => {
      adapter = new CloudflareWorkersAdapter();
    });

    it('should have correct type', () => {
      expect(adapter.type).toBe('cloudflare-workers');
    });

    it('should adapt Workers request', async () => {
      const mockRequest = new Request('https://example.com/api/test?param=value', {
        method: 'GET',
        headers: {
          'cf-connecting-ip': '192.168.1.1',
          'cf-ray': '123abc456def',
          'cf-ipcountry': 'US',
        },
      });

      const mockEnv: WorkersEnv = { API_KEY: 'secret' };
      const mockCtx: WorkersContext = {
        waitUntil: jest.fn(),
        passThroughOnException: jest.fn(),
      };

      const adaptedReq = await adapter.adaptRequest(mockRequest, mockEnv, mockCtx);

      expect(adaptedReq.method).toBe('GET');
      expect(adaptedReq.path).toBe('/api/test');
      expect(adaptedReq.query).toEqual({ param: 'value' });
      expect(adaptedReq.ip).toBe('192.168.1.1');
      expect(adaptedReq.headers['cf-ray']).toBe('123abc456def');
      expect((adaptedReq as any).env).toBe(mockEnv);
      expect((adaptedReq as any).ctx).toBe(mockCtx);
    });

    it('should handle form data', async () => {
      const formData = new FormData();
      formData.append('name', 'test');
      formData.append('email', 'test@example.com');

      const mockRequest = new Request('https://example.com/api/form', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formData,
      });

      const adaptedReq = await adapter.adaptRequest(mockRequest, {}, {} as any);

      expect(adaptedReq.method).toBe('POST');
      expect(typeof adaptedReq.body).toBe('object');
    });

    it('should create Workers handler', () => {
      const mockHandler = jest.fn(async (req: any, res: any) => {});
      const handler = adapter.createServer(mockHandler);

      expect(typeof handler).toBe('function');
    });

    it('should adapt response to Web Response', async () => {
      const mockResponse = {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { worker: true },
      } as any;

      const webResponse = await adapter.adaptResponse(mockResponse);

      expect(webResponse).toBeInstanceOf(Response);
      expect(webResponse.status).toBe(200);

      const responseBody = await webResponse.json();
      expect(responseBody).toEqual({ worker: true });
    });
  });

  describe('response on runtimes without a Node response object', () => {
    // What a handler can call on `res` must not depend on where it runs: each
    // case is answered by the Node http server and by every serverless
    // adapter, and the status, body and headers have to agree.
    const cases: Record<string, (req: any, res: any) => void> = {
      success: (_req, res) => res.success({ id: 1 }, 'done'),
      error: (_req, res) => res.error('Nope', 'E_NOPE', 'not allowed'),
      unauthorized: (_req, res) => res.unauthorized(),
      forbidden: (_req, res) => res.forbidden('Required role: admin'),
      notFound: (_req, res) => res.notFound('Item'),
      badRequest: (_req, res) => res.badRequest('name is required'),
      conflict: (_req, res) => res.conflict('exists'),
      internalError: (_req, res) => res.internalError(),
      validationError: (_req, res) => res.validationError([{ field: 'a', message: 'required' }]),
      rateLimited: (_req, res) => res.rateLimited(30),
      created: (_req, res) => res.created({ id: 2 }, '/items/2'),
      paginated: (_req, res) => res.paginated([1, 2], { page: 2, limit: 2, total: 5 }),
      noContent: (_req, res) => res.noContent(),
      headers: (_req, res) => {
        res.setHeader('X-One', '1');
        res.set('X-Two', '2');
        res.set({ 'X-Three': '3' });
        res.setHeader('x-one', 'replaced');
        res.setHeader('X-Gone', 'x');
        res.removeHeader('x-gone');
        res.json({
          one: res.getHeader('X-ONE'),
          two: res.get('x-two'),
          hasThree: res.hasHeader('x-three'),
          hasGone: res.hasHeader('X-Gone'),
        });
      },
      end: (_req, res) => {
        res.status(202);
        res.setHeader('Content-Type', 'text/plain');
        res.end('accepted');
      },
    };
    const COMPARED = ['location', 'retry-after', 'x-one', 'x-two', 'x-three', 'x-gone'];

    type Answer = { status: number; body: string; headers: Record<string, string | undefined> };
    const pick = (get: (name: string) => string | null | undefined): Answer['headers'] =>
      Object.fromEntries(COMPARED.map(name => [name, get(name) ?? undefined]));

    async function onNode(): Promise<Record<string, Answer>> {
      const server = new MoroHttpServer();
      for (const [name, handler] of Object.entries(cases)) server.get(`/${name}`, handler);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const { port } = server.getServer().address() as { port: number };
      const answers: Record<string, Answer> = {};
      try {
        for (const name of Object.keys(cases)) {
          const res = await fetch(`http://127.0.0.1:${port}/${name}`);
          answers[name] = {
            status: res.status,
            body: await res.text(),
            headers: pick(h => res.headers.get(h)),
          };
        }
      } finally {
        server.getServer().closeAllConnections();
        await server.close();
      }
      return answers;
    }

    const lowerKeys = (headers: Record<string, string>) =>
      Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

    type Handler = (req: any, res: any) => void | Promise<void>;
    const workersContext = { waitUntil: () => {}, passThroughOnException: () => {} } as any;

    const onLambda = async (handler: Handler, event?: LambdaEvent): Promise<LambdaResponse> =>
      (await new AWSLambdaAdapter().createServer(async (req, res) => handler(req, res))(
        event ?? { httpMethod: 'GET', path: '/', headers: {}, body: null },
        { awsRequestId: 'test' } as any
      )) as LambdaResponse;

    // The same handler on Vercel Edge and on Cloudflare Workers
    const onWeb = async (
      handler: Handler,
      init?: RequestInit,
      url = 'https://example.com/'
    ): Promise<[string, Response][]> => {
      const run = async (req: any, res: any) => handler(req, res);
      const request = () => new Request(url, init);
      return [
        ['edge', (await new VercelEdgeAdapter().createServer(run)(request())) as Response],
        [
          'workers',
          (await new CloudflareWorkersAdapter().createServer(run)(
            request(),
            {},
            workersContext
          )) as Response,
        ],
      ];
    };

    // The Node server's answer to the same handler: the Set-Cookie values it sends
    const cookiesOnNode = async (handler: Handler): Promise<string[]> => {
      const server = new MoroHttpServer();
      server.get('/', handler);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const { port } = server.getServer().address() as { port: number };
      try {
        return (await fetch(`http://127.0.0.1:${port}/`)).headers.getSetCookie();
      } finally {
        server.getServer().closeAllConnections();
        await server.close();
      }
    };

    it('sends the same Set-Cookie values as the Node server for res.cookie() and res.clearCookie()', async () => {
      const handler: Handler = (_req, res) => {
        res.cookie('plain', 'value');
        res.cookie('encoded', 'a b;c=d,\u00e9');
        res.cookie('session', 'abc', {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          maxAge: 60 * 60 * 1000, // milliseconds
          path: '/app',
          domain: 'example.com',
        });
        res.cookie('dated', 'x', { expires: new Date('2030-01-02T03:04:05Z'), sameSite: 'lax' });
        res.cookie('expired', 'x', { maxAge: 0 });
        res.cookie('brief', 'x', { maxAge: 1500 });
        res.cookie('no-options', 'x', {});
        res.clearCookie('old');
        res.clearCookie('scoped', {
          path: '/app',
          domain: 'example.com',
          httpOnly: true,
          secure: true,
          sameSite: 'none',
        });
        res.json({ ok: true });
      };

      const expected = await cookiesOnNode(handler);
      expect(expected).toEqual([
        'plain=value; Path=/',
        'encoded=a%20b%3Bc%3Dd%2C%C3%A9; Path=/',
        'session=abc; Max-Age=3600; HttpOnly; Secure; SameSite=strict; Domain=example.com; Path=/app',
        'dated=x; Expires=Wed, 02 Jan 2030 03:04:05 GMT; SameSite=lax; Path=/',
        'expired=x; Max-Age=0; Path=/',
        'brief=x; Max-Age=1; Path=/',
        'no-options=x; Path=/',
        'old=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
        'scoped=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=none; Domain=example.com; Path=/app',
      ]);

      const lambda = await onLambda(handler);
      expect(lambda.multiValueHeaders?.['Set-Cookie']).toEqual(expected);
      // Over plain http, as the Node server above was reached
      for (const [runtime, response] of await onWeb(handler, undefined, 'http://example.com/')) {
        expect({ runtime, cookies: response.headers.getSetCookie() }).toEqual({
          runtime,
          cookies: expected,
        });
      }

      // One cookie stays in `headers` for a REST API, as a single value
      const single: Handler = (_req, res) => {
        res.cookie('sid', 'a b', { httpOnly: true });
        res.json({ ok: true });
      };
      expect(await onLambda(single)).toEqual({
        statusCode: 200,
        headers: {
          'Set-Cookie': (await cookiesOnNode(single))[0],
          'Content-Type': 'application/json',
        },
        body: '{"ok":true}',
        isBase64Encoded: false,
      });
    });

    // No connection reaches a function: the platform in front of it says how
    // the client arrived. A cookie with no `secure` option follows that, as
    // it follows the connection on the HTTP servers.
    it('makes a cookie Secure by default when the platform reports https, and only then', async () => {
      const lambdaFlags = async (event: any) => {
        const reply = await onLambda(setCookies, event);
        return secureFlags(reply.multiValueHeaders?.['Set-Cookie'] ?? reply.cookies);
      };
      const rest = (headers: Record<string, string>) => ({
        httpMethod: 'GET',
        path: '/',
        headers,
        body: null,
      });
      const httpApi = (headers: Record<string, string>) => ({
        version: '2.0',
        rawPath: '/',
        rawQueryString: '',
        headers,
        requestContext: { http: { method: 'GET', path: '/', sourceIp: '203.0.113.9' } },
      });

      // API Gateway and load balancers write X-Forwarded-Proto themselves
      expect(await lambdaFlags(rest({ 'X-Forwarded-Proto': 'https' }))).toEqual(OVER_TLS);
      expect(await lambdaFlags(rest({ 'X-Forwarded-Proto': 'http' }))).toEqual(OVER_HTTP);
      expect(await lambdaFlags(rest({}))).toEqual(OVER_HTTP);
      expect(await lambdaFlags(httpApi({ 'x-forwarded-proto': 'https' }))).toEqual(OVER_TLS);
      expect(await lambdaFlags(httpApi({ 'x-forwarded-proto': 'http' }))).toEqual(OVER_HTTP);

      // Edge and Workers: the scheme of the URL the platform hands over
      for (const [url, expected] of [
        ['https://example.com/', OVER_TLS],
        ['http://example.com/', OVER_HTTP],
      ] as const) {
        for (const [runtime, response] of await onWeb(setCookies, undefined, url)) {
          expect({ runtime, url, ...secureFlags(response.headers.getSetCookie()) }).toEqual({
            runtime,
            url,
            ...expected,
          });
        }
      }
      // A header any client can send is not what decides there
      for (const [runtime, response] of await onWeb(
        setCookies,
        { headers: { 'x-forwarded-proto': 'https' } },
        'http://example.com/'
      )) {
        expect({ runtime, ...secureFlags(response.headers.getSetCookie()) }).toEqual({
          runtime,
          ...OVER_HTTP,
        });
      }
    });

    // Every way a Cookie header reaches a handler on the serverless runtimes:
    // each entry answers a request that carries `cookieHeader`
    const lambdaCtx = { awsRequestId: 'test' } as any;
    const cookieSources: Record<string, (handler: Handler, cookieHeader: string) => Promise<any>> =
      {
        'lambda REST API, cookie': (handler, cookie) =>
          onLambda(handler, { httpMethod: 'GET', path: '/', headers: { cookie }, body: null }),
        'lambda REST API, Cookie': (handler, cookie) =>
          onLambda(handler, {
            httpMethod: 'GET',
            path: '/',
            headers: { Cookie: cookie },
            body: null,
          }),
        'lambda REST API, COOKIE': (handler, cookie) =>
          onLambda(handler, {
            httpMethod: 'GET',
            path: '/',
            headers: { COOKIE: cookie },
            body: null,
          }),
        // API Gateway hands the header over split into its cookies
        'lambda payload format 2.0': (handler, cookie) =>
          new AWSLambdaAdapter().createServer(async (req, res) => handler(req, res))(
            {
              version: '2.0',
              rawPath: '/',
              rawQueryString: '',
              cookies: cookie.split(';').map(part => part.trim()),
              headers: {},
              requestContext: { http: { method: 'GET' } },
            },
            lambdaCtx
          ),
        'lambda load balancer, multi-value': (handler, cookie) =>
          new AWSLambdaAdapter().createServer(async (req, res) => handler(req, res))(
            {
              httpMethod: 'GET',
              path: '/',
              multiValueHeaders: { cookie: [cookie] },
              body: null,
              requestContext: { elb: {} },
            },
            lambdaCtx
          ),
        edge: async (handler, cookie) => (await onWeb(handler, { headers: { cookie } }))[0]![1],
        workers: async (handler, cookie) => (await onWeb(handler, { headers: { cookie } }))[1]![1],
      };
    const bodyOf = async (answer: any): Promise<any> =>
      answer instanceof Response ? answer.json() : JSON.parse(answer.body);
    const setCookiesOf = (answer: any): string[] =>
      answer instanceof Response
        ? answer.headers.getSetCookie()
        : (answer.cookies ??
          answer.multiValueHeaders?.['Set-Cookie'] ?? [answer.headers['Set-Cookie']]);

    it('reads req.cookies from a Cookie header as the Node server does', async () => {
      const cookieHeaders = [
        'sid=abc; theme=dark',
        'encoded=a%20b%3Bc%3Dd; unicode=%C3%A9; plus=a+b',
        'malformed=100%; cut=%E0%A4%A; fine=1',
        'quoted="a b"; half="open',
        'dup=first; dup=second; other=1',
        'empty=; kept=1; novalue; =noname',
        'spaced = x ;  padded=y',
        'equals=a=b=c; __proto__=x; constructor=y',
      ];
      const echo: Handler = (req, res) => res.json({ cookies: req.cookies });

      // What the Node server makes of each header
      const server = new MoroHttpServer();
      server.get('/', echo);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const { port } = server.getServer().address() as { port: number };
      const expected: Record<string, any> = {};
      try {
        for (const cookie of cookieHeaders) {
          const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
          expected[cookie] = ((await response.json()) as { cookies: unknown }).cookies;
        }
      } finally {
        server.getServer().closeAllConnections();
        await server.close();
      }
      expect(expected[cookieHeaders[1]!]).toEqual({
        encoded: 'a b;c=d',
        unicode: '\u00e9',
        plus: 'a+b',
      });
      // Not valid percent-encoding: the value as sent, and no error
      expect(expected[cookieHeaders[2]!]).toEqual({
        malformed: '100%',
        cut: '%E0%A4%A',
        fine: '1',
      });
      expect(expected[cookieHeaders[3]!]).toEqual({ quoted: '"a b"', half: '"open' });
      expect(expected[cookieHeaders[4]!]).toEqual({ dup: 'second', other: '1' });
      expect(expected[cookieHeaders[5]!]).toEqual({ kept: '1' });

      for (const [source, answer] of Object.entries(cookieSources)) {
        for (const cookie of cookieHeaders) {
          // The platform trims each entry of the list it builds for payload format 2.0
          if (source === 'lambda payload format 2.0' && cookie.startsWith('spaced')) continue;
          expect({
            source,
            cookie,
            cookies: (await bodyOf(await answer(echo, cookie))).cookies,
          }).toEqual({
            source,
            cookie,
            cookies: expected[cookie],
          });
        }
      }
    });

    it('reads back the value res.cookie() wrote', async () => {
      const values: Record<string, string> = {
        plain: 'abc123',
        spaced: 'a b',
        separators: 'x;y=z,w',
        percent: '100%',
        encodedAlready: 'a%20b',
        quoted: '"q"',
        unicode: 'caf\u00e9 \u2713',
        json: '{"id":1,"tags":["a","b"]}',
      };
      const handler: Handler = (req, res) => {
        for (const [name, value] of Object.entries(values)) {
          res.cookie(name, value, { httpOnly: true });
        }
        res.json({ cookies: req.cookies });
      };

      for (const [source, answer] of Object.entries(cookieSources)) {
        const first = await answer(handler, '');
        // What a browser sends back: the name=value of every Set-Cookie
        const cookieHeader = setCookiesOf(first)
          .map(cookie => cookie.substring(0, cookie.indexOf(';')))
          .join('; ');

        const second = await answer(handler, cookieHeader);

        expect({ source, cookies: (await bodyOf(second)).cookies }).toEqual({
          source,
          cookies: values,
        });
      }
    });

    // Keep this the first test in the file that passes `signed` to
    // res.cookie(): the notice is given once per process.
    it('says once that a cookie asked to be signed was sent unsigned', async () => {
      const warn = jest.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
      try {
        const handler: Handler = (_req, res) => {
          res.cookie('session', 'abc', { signed: true });
          res.cookie('other', 'x', { signed: true });
          res.json({ ok: true });
        };

        const lambda = await onLambda(handler);
        await onWeb(handler);

        expect(lambda.multiValueHeaders?.['Set-Cookie']).toEqual([
          'session=abc; Path=/',
          'other=x; Path=/',
        ]);
        const notices = warn.mock.calls.filter(call => call[1] === 'CookieWarning');
        expect(notices).toHaveLength(1);
        expect(notices[0]?.[0]).toMatch(/res\.cookie\('session'.*signed: true.*UNSIGNED/);
      } finally {
        warn.mockRestore();
      }
    });

    it('sends every cookie as a Set-Cookie header of its own', async () => {
      const handlers: Record<string, [Handler, string[]]> = {
        'cookie() twice': [
          (_req, res) => {
            res.cookie('sid', 'abc');
            res.cookie('theme', 'dark');
            res.json({ seen: res.getHeader('Set-Cookie') });
          },
          ['sid=abc; Path=/', 'theme=dark; Path=/'],
        ],
        'cookie() then clearCookie()': [
          (_req, res) => {
            res.cookie('keep', '1');
            res.clearCookie('session');
            res.json({ ok: true });
          },
          ['keep=1; Path=/', 'session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'],
        ],
        'setHeader() with a list': [
          (_req, res) => {
            res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
            res.json({ ok: true });
          },
          ['a=1; Path=/', 'b=2; Path=/'],
        ],
        'append() twice': [
          (_req, res) => {
            res.append('Set-Cookie', 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
            res.append('set-cookie', 'b=2');
            res.json({ ok: true });
          },
          ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2'],
        ],
        'setHeader() after cookie() replaces': [
          (_req, res) => {
            res.cookie('old', '1');
            res.cookie('older', '1');
            res.setHeader('Set-Cookie', ['a=1', 'b=2']);
            res.json({ ok: true });
          },
          ['a=1', 'b=2'],
        ],
      };

      for (const [name, [handler, expected]] of Object.entries(handlers)) {
        const lambda = await onLambda(handler);
        expect({ name, runtime: 'lambda', cookies: lambda.multiValueHeaders }).toEqual({
          name,
          runtime: 'lambda',
          cookies: { 'Set-Cookie': expected },
        });
        // Not in `headers` as well: a REST API would send it twice
        expect(lambda.headers).toEqual({ 'Content-Type': 'application/json' });

        for (const [runtime, response] of await onWeb(handler, undefined, 'http://example.com/')) {
          expect({ name, runtime, cookies: response.headers.getSetCookie() }).toEqual({
            name,
            runtime,
            cookies: expected,
          });
        }
      }

      // What the handler reads back is the list, as on the Node server
      expect(JSON.parse((await onLambda(handlers['cookie() twice']![0])).body)).toEqual({
        seen: ['sid=abc; Path=/', 'theme=dark; Path=/'],
      });
    });

    it('leaves a removed Set-Cookie out, and a single one where it always was', async () => {
      const removed = await onLambda((_req, res) => {
        res.cookie('a', '1');
        res.cookie('b', '2');
        res.removeHeader('Set-Cookie');
        res.json({ has: res.hasHeader('set-cookie') });
      });
      expect(removed.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(removed.multiValueHeaders).toBeUndefined();
      expect(removed.body).toBe('{"has":false}');

      const single = await onLambda((_req, res) => {
        res.setHeader('Set-Cookie', 'a=1; Path=/');
        res.json({ seen: res.getHeader('set-cookie') });
      });
      expect(single.headers).toEqual({
        'Set-Cookie': 'a=1; Path=/',
        'Content-Type': 'application/json',
      });
      expect(single.multiValueHeaders).toBeUndefined();
      expect(single.body).toBe('{"seen":"a=1; Path=/"}');
    });

    it('keeps the latest cookie in headers for a load balancer without multi-value headers', async () => {
      const lambda = await onLambda(
        (_req, res) => {
          res.cookie('sid', 'abc');
          res.cookie('theme', 'dark');
          res.json({ ok: true });
        },
        {
          httpMethod: 'GET',
          path: '/',
          headers: { host: 'alb.example.com' },
          body: null,
          requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:tg' } },
        }
      );

      // Such a load balancer reads `headers` only, and one value per name
      expect(lambda.headers).toEqual({
        'Set-Cookie': 'theme=dark; Path=/',
        'Content-Type': 'application/json',
      });
    });

    it('sends binary bodies as bytes, under the content type the handler set', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
      const bodies: Record<string, () => any> = {
        Buffer: () => png,
        Uint8Array: () => new Uint8Array(png),
        ArrayBuffer: () => new Uint8Array(png).buffer,
        DataView: () => new DataView(new Uint8Array(png).buffer),
      };

      for (const [kind, body] of Object.entries(bodies)) {
        const typed: Handler = (_req, res) => {
          res.setHeader('Content-Type', 'image/png');
          res.send(body());
        };
        const untyped: Handler = (_req, res) => res.end(body());

        expect({ kind, ...(await onLambda(typed)) }).toEqual({
          kind,
          statusCode: 200,
          headers: { 'Content-Type': 'image/png' },
          body: png.toString('base64'),
          isBase64Encoded: true,
        });
        expect((await onLambda(untyped)).headers).toEqual({
          'Content-Type': 'application/octet-stream',
        });

        for (const [runtime, response] of await onWeb(typed)) {
          expect({
            kind,
            runtime,
            type: response.headers.get('content-type'),
            hex: Buffer.from(await response.arrayBuffer()).toString('hex'),
          }).toEqual({ kind, runtime, type: 'image/png', hex: png.toString('hex') });
        }
        for (const [runtime, response] of await onWeb(untyped)) {
          expect({ kind, runtime, type: response.headers.get('content-type') }).toEqual({
            kind,
            runtime,
            type: 'application/octet-stream',
          });
        }
      }
    });

    it('streams a ReadableStream body on Vercel Edge and Cloudflare Workers', async () => {
      const handler: Handler = (_req, res) => {
        res.setHeader('Content-Type', 'text/plain');
        res.send(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first,'));
              controller.enqueue(new TextEncoder().encode('second'));
              controller.close();
            },
          })
        );
      };

      for (const [runtime, response] of await onWeb(handler)) {
        expect({
          runtime,
          type: response.headers.get('content-type'),
          body: await response.text(),
        }).toEqual({ runtime, type: 'text/plain', body: 'first,second' });
      }
    });

    it('keeps sending objects as JSON and strings as they are', async () => {
      const object: Handler = (_req, res) => {
        res.setHeader('Content-Type', 'text/plain');
        res.send({ a: 1 });
      };
      const text: Handler = (_req, res) => res.send('plain text');
      const jsonString: Handler = (_req, res) => res.json('hello');
      const twice: Handler = (_req, res) => {
        res.status(401).json({ denied: true });
        res.json({ second: true });
      };

      expect(await onLambda(object)).toEqual({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}',
        isBase64Encoded: false,
      });
      expect(await onLambda(text)).toEqual({
        statusCode: 200,
        headers: {},
        body: 'plain text',
        isBase64Encoded: false,
      });
      expect((await onLambda(jsonString)).body).toBe('hello');
      expect(await onLambda(twice)).toMatchObject({ statusCode: 401, body: '{"second":true}' });

      for (const [runtime, response] of await onWeb(object)) {
        expect({
          runtime,
          type: response.headers.get('content-type'),
          body: await response.text(),
        }).toEqual({ runtime, type: 'application/json', body: '{"a":1}' });
      }
      for (const [runtime, response] of await onWeb(jsonString)) {
        expect({ runtime, body: await response.text() }).toEqual({ runtime, body: 'hello' });
      }
      for (const [runtime, response] of await onWeb(twice)) {
        expect({ runtime, status: response.status, body: await response.text() }).toEqual({
          runtime,
          status: 401,
          body: '{"second":true}',
        });
      }
    });

    it('refuses a cookie name or attribute that would change the header', async () => {
      const handler: Handler = (_req, res) => {
        const outcome: string[] = [];
        const attempt = (set: () => void) => {
          try {
            set();
            outcome.push('sent');
          } catch (error) {
            outcome.push((error as Error).name);
          }
        };
        attempt(() => res.cookie('a b', 'x'));
        attempt(() => res.cookie('sid', 'x', { path: '/app\r\nX-Injected: 1' }));
        attempt(() => res.cookie('sid', 'x', { domain: 'example.com; Secure' }));
        attempt(() => res.cookie('sid', 'x', { sameSite: 'lax; Secure' as any }));
        res.json({ outcome });
      };
      const refused = { outcome: ['TypeError', 'TypeError', 'TypeError', 'TypeError'] };

      expect(await cookiesOnNode(handler)).toEqual([]);
      const lambda = await onLambda(handler);
      expect(JSON.parse(lambda.body)).toEqual(refused);
      expect(lambda.multiValueHeaders?.['Set-Cookie']).toBeUndefined();
      expect(lambda.headers?.['Set-Cookie']).toBeUndefined();
      for (const [runtime, response] of await onWeb(handler)) {
        expect({
          runtime,
          cookies: response.headers.getSetCookie(),
          body: await response.json(),
        }).toEqual({ runtime, cookies: [], body: refused });
      }
    });

    it('strips CR and LF from header values', async () => {
      const redirect: Handler = (_req, res) => res.redirect('/next\r\nSet-Cookie: injected=1');
      const header: Handler = (_req, res) => {
        res.setHeader('X-Test', 'a\r\nX-Injected: 1');
        res.append('X-List', 'one\n');
        res.append('X-List', 'two\r');
        res.cookie('sid', 'abc\r\nX-Injected: 1', { path: '/app' });
        res.json({ ok: true });
      };

      expect(await onLambda(redirect)).toEqual({
        statusCode: 302,
        headers: { Location: '/nextSet-Cookie: injected=1' },
        body: '',
        isBase64Encoded: false,
      });
      expect((await onLambda(header)).headers).toEqual({
        'X-Test': 'aX-Injected: 1',
        'X-List': 'one, two',
        'Set-Cookie': 'sid=abc%0D%0AX-Injected%3A%201; Path=/app',
        'Content-Type': 'application/json',
      });

      for (const [runtime, response] of await onWeb(redirect)) {
        expect({
          runtime,
          status: response.status,
          location: response.headers.get('location'),
          cookies: response.headers.getSetCookie(),
        }).toEqual({
          runtime,
          status: 302,
          location: '/nextSet-Cookie: injected=1',
          cookies: [],
        });
      }
      for (const [runtime, response] of await onWeb(header)) {
        expect({
          runtime,
          status: response.status,
          test: response.headers.get('x-test'),
          list: response.headers.get('x-list'),
          injected: response.headers.get('x-injected'),
        }).toEqual({
          runtime,
          status: 200,
          test: 'aX-Injected: 1',
          list: 'one, two',
          injected: null,
        });
      }
    });

    it('answers a status that cannot carry a body on Vercel Edge and Cloudflare Workers', async () => {
      const statuses: Record<number, Handler> = {
        204: (_req, res) => res.status(204).json({}),
        205: (_req, res) => res.status(205).send('reset'),
        304: (_req, res) => {
          res.setHeader('ETag', '"v1"');
          res.status(304).json({ ignored: true });
        },
      };

      for (const [status, handler] of Object.entries(statuses)) {
        for (const [runtime, response] of await onWeb(handler)) {
          expect({ runtime, status: response.status, body: await response.text() }).toEqual({
            runtime,
            status: Number(status),
            body: '',
          });
        }
      }
      const [, notModified] = (await onWeb(statuses[304]!))[0]!;
      expect(notModified.headers.get('etag')).toBe('"v1"');
    });

    it('answers malformed JSON on Vercel Edge and Cloudflare Workers as the Node server does', async () => {
      const post = (body: string): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const echo: Handler = (req, res) => res.json({ body: req.body });

      // The Node server's answer to the same request
      const server = new MoroHttpServer();
      const logged = jest.spyOn(server.logger, 'error').mockImplementation(() => {});
      server.post('/', echo);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const { port } = server.getServer().address() as { port: number };
      let expected: { status: number; body: any };
      let expectedEmpty: { status: number; body: any };
      try {
        const malformed = await fetch(`http://127.0.0.1:${port}/`, post('{"a":'));
        expected = { status: malformed.status, body: await malformed.json() };
        const empty = await fetch(`http://127.0.0.1:${port}/`, post(''));
        expectedEmpty = { status: empty.status, body: await empty.json() };
      } finally {
        server.getServer().closeAllConnections();
        await server.close();
        logged.mockRestore();
      }
      expect(expected).toEqual({
        status: 400,
        body: { success: false, error: 'Invalid request body', requestId: expect.any(String) },
      });

      for (const [runtime, response] of await onWeb(echo, post('{"a":'))) {
        expect({ runtime, status: response.status, body: await response.json() }).toEqual({
          runtime,
          status: expected.status,
          body: { ...expected.body, requestId: expect.any(String) },
        });
      }
      // An empty body is not an error
      for (const [runtime, response] of await onWeb(echo, post(''))) {
        expect({ runtime, status: response.status, body: await response.json() }).toEqual({
          runtime,
          ...expectedEmpty,
        });
      }
      for (const [runtime, response] of await onWeb(echo, post('{"a":1}'))) {
        expect({ runtime, status: response.status, body: await response.json() }).toEqual({
          runtime,
          status: 200,
          body: { body: { a: 1 } },
        });
      }
    });

    it('offers the same header access and helpers as the Node server', async () => {
      const expected = await onNode();

      for (const name of Object.keys(cases)) {
        const handler = async (req: any, res: any) => cases[name]!(req, res);

        const lambda = (await new AWSLambdaAdapter().createServer(handler)(
          { httpMethod: 'GET', path: `/${name}`, headers: {}, body: null } as LambdaEvent,
          { awsRequestId: 'test' } as any
        )) as { statusCode: number; headers: Record<string, string>; body: string };
        const lambdaHeaders = lowerKeys(lambda.headers);
        expect({
          runtime: 'lambda',
          name,
          status: lambda.statusCode,
          body: lambda.body ?? '',
          headers: pick(h => lambdaHeaders[h]),
        }).toEqual({ runtime: 'lambda', name, ...expected[name] });

        const request = new Request(`https://example.com/${name}`);
        const edge = (await new VercelEdgeAdapter().createServer(handler)(request)) as Response;
        expect({
          runtime: 'edge',
          name,
          status: edge.status,
          body: await edge.text(),
          headers: pick(h => edge.headers.get(h)),
        }).toEqual({ runtime: 'edge', name, ...expected[name] });

        const worker = (await new CloudflareWorkersAdapter().createServer(handler)(
          new Request(`https://example.com/${name}`),
          {},
          { waitUntil: () => {}, passThroughOnException: () => {} } as any
        )) as Response;
        expect({
          runtime: 'workers',
          name,
          status: worker.status,
          body: await worker.text(),
          headers: pick(h => worker.headers.get(h)),
        }).toEqual({ runtime: 'workers', name, ...expected[name] });
      }
    });
  });

  describe('Integration Tests', () => {
    it('should handle request/response cycle for all adapters', async () => {
      const adapters = [
        new NodeRuntimeAdapter(),
        new VercelEdgeAdapter(),
        new AWSLambdaAdapter(),
        new CloudflareWorkersAdapter(),
      ];

      for (const adapter of adapters) {
        const mockHandler = jest.fn(async (req: any, res: any) => {
          res.json({ runtime: adapter.type, path: req.path });
        });

        const handler = adapter.createServer(mockHandler);
        expect(handler).toBeDefined();

        // Node.js adapter returns MoroHttpServer object, others return functions
        if (adapter.type === 'node') {
          expect(typeof handler).toBe('object');
          expect(typeof (handler as any).listen).toBe('function');
        } else {
          expect(typeof handler).toBe('function');
        }
      }
    });

    it('should preserve request data through adaptation', async () => {
      const testData = { test: 'data', number: 42 };

      // Test Vercel Edge
      const edgeAdapter = new VercelEdgeAdapter();
      const edgeRequest = new Request('https://example.com/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testData),
      });

      const adaptedEdgeReq = await edgeAdapter.adaptRequest(edgeRequest);
      expect(adaptedEdgeReq.body).toEqual(testData);

      // Test Lambda
      const lambdaAdapter = new AWSLambdaAdapter();
      const lambdaEvent: LambdaEvent = {
        httpMethod: 'POST',
        path: '/api/test',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testData),
      };
      const lambdaContext = { awsRequestId: 'test' } as any;

      const adaptedLambdaReq = await lambdaAdapter.adaptRequest(lambdaEvent, lambdaContext);
      expect(adaptedLambdaReq.body).toEqual(testData);
    });
  });

  // The handler getHandler() returns runs what the servers run for a request:
  // request hooks, the global middleware chain (app.use() and the
  // config-driven kind), then the router. One request shape per runtime.
  describe('getHandler() on serverless runtimes', () => {
    type Invoke = (
      path: string,
      headers?: Record<string, string>,
      method?: string
    ) => Promise<{ status: number; headers: Record<string, string>; body: string; raw: any }>;

    const lower = (headers: Record<string, any>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const name of Object.keys(headers)) out[name.toLowerCase()] = String(headers[name]);
      return out;
    };

    const RUNTIMES: Array<[string, (options: any) => Promise<any>, (handler: any) => Invoke]> = [
      [
        'AWS Lambda',
        createAppLambda,
        handler =>
          async (path, headers = {}, method = 'GET') => {
            const raw = await handler(
              { httpMethod: method, path, headers },
              { awsRequestId: 'request-1' }
            );
            return {
              status: raw.statusCode,
              headers: lower(raw.headers ?? {}),
              body: raw.body,
              raw,
            };
          },
      ],
      [
        'Vercel Edge',
        createAppEdge,
        handler =>
          async (path, headers = {}, method = 'GET') => {
            const raw: Response = await handler(
              new Request(`https://app.example${path}`, { headers, method })
            );
            return {
              status: raw.status,
              headers: Object.fromEntries(raw.headers),
              body: await raw.text(),
              raw,
            };
          },
      ],
      [
        'Cloudflare Workers',
        createAppWorker,
        handler =>
          async (path, headers = {}, method = 'GET') => {
            const raw: Response = await handler(
              new Request(`https://app.example${path}`, { headers, method }),
              {},
              { waitUntil() {}, passThroughOnException() {} }
            );
            return {
              status: raw.status,
              headers: Object.fromEntries(raw.headers),
              body: await raw.text(),
              raw,
            };
          },
      ],
    ];

    describe.each(RUNTIMES)('%s', (_name, createRuntimeApp, invoker) => {
      let app: any;

      async function createServerlessApp(options: any = {}) {
        resetConfig();
        UnifiedRouter.reset();
        app = await createRuntimeApp({
          logger: { level: 'fatal' },
          autoDiscover: false,
          routing: false,
          ...options,
          server: { requestLogging: { enabled: false }, ...options.server },
        });
        return app;
      }

      afterEach(async () => {
        if (app) await closeApp(app);
        app = undefined;
        resetConfig();
        jest.restoreAllMocks();
      });

      it('runs app.use() middleware after request hooks and before the route, in order', async () => {
        await createServerlessApp();
        const order: string[] = [];
        app.hooks.before('request', () => {
          order.push('hook');
        });
        await app.use((_req: any, res: any, next: () => void) => {
          order.push('first');
          res.setHeader('X-First', 'yes');
          next();
        });
        await app.use(async (req: any, _res: any, next: () => void) => {
          await Promise.resolve();
          order.push('second');
          req.checkedBy = 'second';
          next();
        });
        app.get('/who', (req: any) => {
          order.push('route');
          return { checkedBy: req.checkedBy };
        });

        const invoke = invoker(app.getHandler());
        // Registered after getHandler(): part of the chain all the same.
        await app.use((_req: any, _res: any, next: () => void) => {
          order.push('third');
          next();
        });

        const reply = await invoke('/who');
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.body)).toEqual({ checkedBy: 'second' });
        expect(reply.headers['x-first']).toBe('yes');
        expect(order).toEqual(['hook', 'first', 'second', 'third', 'route']);
      });

      it('lets a guard answer the request, so the route never runs', async () => {
        await createServerlessApp();
        let routeRan = 0;
        await app.use((req: any, res: any, next: () => void) => {
          if (req.headers.authorization !== 'Bearer good') {
            res.status(401).json({ error: 'sign in' });
            return;
          }
          next();
        });
        app.get('/private', () => {
          routeRan++;
          return { secret: true };
        });
        app.get('/banner', 'build 1.2.3');
        const invoke = invoker(app.getHandler());

        for (const path of ['/private', '/banner', '/no-such-route']) {
          const denied = await invoke(path);
          expect(`${path} ${denied.status}`).toBe(`${path} 401`);
          expect(JSON.parse(denied.body)).toEqual({ error: 'sign in' });
        }
        expect(routeRan).toBe(0);

        const allowed = await invoke('/private', { authorization: 'Bearer good' });
        expect(allowed.status).toBe(200);
        expect(JSON.parse(allowed.body)).toEqual({ secret: true });
      });

      it('returns when a middleware answers from a callback and never calls next()', async () => {
        await createServerlessApp();
        await app.use((req: any, res: any, next: () => void) => {
          // The callback style of an asynchronous check: nothing is returned.
          setTimeout(() => {
            if (req.path === '/denied') res.status(403).json({ error: 'no' });
            else next();
          }, 5);
        });
        app.get('/denied', () => ({ reached: true }));
        app.get('/allowed', () => ({ reached: true }));
        const invoke = invoker(app.getHandler());

        const denied = await invoke('/denied');
        expect(denied.status).toBe(403);
        expect(JSON.parse(denied.body)).toEqual({ error: 'no' });
        const allowed = await invoke('/allowed');
        expect(allowed.status).toBe(200);
        expect(JSON.parse(allowed.body)).toEqual({ reached: true });
      });

      it('passes next(err) to error middleware, then to the error handler, then answers 500', async () => {
        await createServerlessApp();
        const order: string[] = [];
        await app.use((req: any, _res: any, next: (err?: any) => void) => {
          if (req.path === '/thrown') throw new Error('thrown: /srv/app/secret.pem');
          next(new Error('passed: /srv/app/secret.pem'));
        });
        await app.use((_req: any, _res: any, next: () => void) => {
          order.push('skipped while an error is active');
          next();
        });
        await app.use((err: any, req: any, res: any, next: (err?: any) => void) => {
          order.push('error middleware');
          if (req.path === '/recovered') {
            res.status(409).json({ recovered: true });
            return;
          }
          next(err);
        });
        app.get('/recovered', () => ({ reached: true }));
        app.get('/failed', () => ({ reached: true }));
        app.get('/thrown', () => ({ reached: true }));
        const invoke = invoker(app.getHandler());

        const recovered = await invoke('/recovered');
        expect(recovered.status).toBe(409);
        expect(JSON.parse(recovered.body)).toEqual({ recovered: true });

        for (const path of ['/failed', '/thrown']) {
          const failed = await invoke(path);
          expect(failed.status).toBe(500);
          const body = JSON.parse(failed.body);
          expect(body).toEqual({
            success: false,
            error: 'Internal server error',
            requestId: body.requestId,
          });
          expect(typeof body.requestId).toBe('string');
          expect(failed.body).not.toContain('secret.pem');
        }
        expect(order).toEqual(['error middleware', 'error middleware', 'error middleware']);

        // The application's own error handler shapes the answer when there is one.
        app.setErrorHandler((err: any, _req: any, res: any) => {
          res.status(503).json({ handled: err.message.split(':')[0] });
        });
        const handled = await invoke('/failed');
        expect(handled.status).toBe(503);
        expect(JSON.parse(handled.body)).toEqual({ handled: 'passed' });
      });

      it('applies config-driven helmet and CORS, and leaves compression to the platform', async () => {
        await createServerlessApp({
          security: {
            helmet: { enabled: true },
            cors: { enabled: true, origin: 'https://site.example' },
          },
          performance: { compression: { enabled: true } },
        });
        const large = { text: 'compress me '.repeat(4000) }; // above the inline limit
        app.get('/large', () => large);
        app.get('/small', () => ({ text: 'compress me '.repeat(200) }));
        const invoke = invoker(app.getHandler());

        for (const path of ['/large', '/small']) {
          const reply = await invoke(path, {
            origin: 'https://site.example',
            'accept-encoding': 'gzip, br',
          });
          expect(reply.status).toBe(200);
          expect(reply.headers['x-content-type-options']).toBe('nosniff');
          expect(reply.headers['access-control-allow-origin']).toBe('https://site.example');
          // One buffered body, as the handler returned it: the platform in
          // front of the function is what negotiates an encoding.
          expect(reply.headers['content-encoding']).toBeUndefined();
          expect(JSON.parse(reply.body).text.startsWith('compress me ')).toBe(true);
          if ('isBase64Encoded' in reply.raw) expect(reply.raw.isBase64Encoded).toBe(false);
        }

        const preflight = await invoker(app.getHandler())('/large', {
          origin: 'https://other.example',
        });
        expect(preflight.headers['access-control-allow-origin']).not.toBe('https://other.example');
      });

      // The configured rate limit and CSRF check answer in a request hook,
      // before helmet and CORS (global middleware) have run. Their answers
      // carry the headers of both, as they do on the Node.js server.
      it('gives a configured 429 and CSRF 403 the helmet and CORS headers', async () => {
        await createServerlessApp({
          security: {
            helmet: { enabled: true },
            cors: {
              enabled: true,
              origin: ['https://site.example'],
              credentials: true,
              exposedHeaders: ['Retry-After'],
            },
            // OPTIONS is checked like any other method here
            csrf: { enabled: true, ignoreMethods: ['GET', 'HEAD'] },
            rateLimit: { global: { enabled: true, requests: 2, window: 60000 } },
          },
        });
        app.get('/limited', () => ({ ok: true }));
        const invoke = invoker(app.getHandler());
        const origin = { origin: 'https://site.example' };
        const corsOf = (reply: { headers: Record<string, string> }) => ({
          allowOrigin: reply.headers['access-control-allow-origin'],
          credentials: reply.headers['access-control-allow-credentials'],
          exposed: reply.headers['access-control-expose-headers'],
        });
        const readable = {
          allowOrigin: 'https://site.example',
          credentials: 'true',
          exposed: 'Retry-After',
        };

        // A preflight is CORS's to answer: not counted, not asked for a token
        for (let i = 0; i < 4; i++) {
          const asked = await invoke(
            '/limited',
            { ...origin, 'access-control-request-method': 'POST' },
            'OPTIONS'
          );
          expect(`preflight ${i}: ${asked.status}`).toBe(`preflight ${i}: 204`);
          expect(corsOf(asked)).toEqual(readable);
        }

        const forbidden = await invoke('/limited', origin, 'POST');
        expect(forbidden.status).toBe(403);
        expect(JSON.parse(forbidden.body).code).toBe('CSRF_TOKEN_MISMATCH');
        expect(corsOf(forbidden)).toEqual(readable);
        expect(forbidden.headers['x-content-type-options']).toBe('nosniff');

        const served = await invoke('/limited', origin);
        expect(served.status).toBe(200);
        expect((await invoke('/limited', origin)).status).toBe(200);
        const refused = await invoke('/limited', origin);
        expect(refused.status).toBe(429);
        expect(refused.headers['retry-after']).toBe('60');
        expect(corsOf(refused)).toEqual(corsOf(served));
        expect(corsOf(refused)).toEqual(readable);
        expect(refused.headers['x-content-type-options']).toBe('nosniff');
        expect(refused.headers['x-frame-options']).toBe(served.headers['x-frame-options']);

        // An origin the application does not allow is named none
        const foreign = await invoke('/limited', { origin: 'https://other.example' });
        expect(foreign.status).toBe(429);
        expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
      });

      it('reads a dot in the fixed text of a parameter route as a dot', async () => {
        await createServerlessApp();
        app.get('/u/:id/v1.0', (req: any) => ({ id: req.params.id }));
        const invoke = invoker(app.getHandler());

        expect((await invoke('/u/7/v1.0')).status).toBe(200);
        expect((await invoke('/u/7/v1X0')).status).toBe(404);
      });

      it('with routing.strictMiddleware, waits for a route middleware that calls next() or answers from a callback', async () => {
        await createServerlessApp({ routing: { enabled: false, strictMiddleware: true } });
        const order: string[] = [];
        app
          .get('/account')
          .before((_req: any, _res: any, next: () => void) => {
            setTimeout(() => {
              order.push('callback');
              next();
            }, 5);
          })
          .handler(() => {
            order.push('handler');
            return { ok: true };
          });
        app
          .get('/denied')
          .before((_req: any, res: any, _next: () => void) => {
            setTimeout(() => res.status(403).json({ denied: true }), 5);
          })
          .handler(() => {
            order.push('denied handler');
            return { ok: true };
          });
        app
          .get('/forgot')
          .before(async (_req: any, _res: any, _next: () => void) => {})
          .handler(() => {
            order.push('forgot handler');
            return { ok: true };
          });
        const invoke = invoker(app.getHandler());

        expect((await invoke('/account')).status).toBe(200);
        expect(order).toEqual(['callback', 'handler']);
        // The invocation returns with the answer the callback gave
        const denied = await invoke('/denied');
        expect(denied.status).toBe(403);
        expect(JSON.parse(denied.body)).toEqual({ denied: true });
        expect((await invoke('/forgot')).status).toBe(500);
        expect(order).toEqual(['callback', 'handler']);
      });

      it('answers optional parameters and wildcards as the servers do', async () => {
        await createServerlessApp();
        await registerSyntaxRoutes(app);
        const invoke = invoker(app.getHandler());

        const answers = await collectAnswers(SYNTAX_CASES, async url => {
          const reply = await invoke(url);
          return describeReply(reply.status, reply.body);
        });
        expect(answers).toEqual(expectedAnswers(SYNTAX_CASES));

        const passed = await invoke('/files/private/x', { 'x-pass': 'yes' });
        expect(JSON.parse(passed.body)).toEqual({
          route: '/files/*',
          params: { '*': 'private/x' },
        });
      });

      it('leaves a body to the platform when compression() is given a filter', async () => {
        await createServerlessApp({});
        await app.use(compression({ threshold: 1024, filter: () => true }));
        const large = { text: 'compress me '.repeat(4000) };
        app.get('/large', () => large);
        app.get('/small', () => ({ text: 'compress me '.repeat(400) }));
        const invoke = invoker(app.getHandler());

        for (const path of ['/large', '/small']) {
          const reply = await invoke(path, { 'accept-encoding': 'gzip, br' });
          expect(reply.status).toBe(200);
          expect(reply.headers['content-encoding']).toBeUndefined();
          expect(JSON.parse(reply.body).text.startsWith('compress me ')).toBe(true);
          if ('isBase64Encoded' in reply.raw) expect(reply.raw.isBase64Encoded).toBe(false);
        }
      });

      it("emits 'finish' for middleware that waits for the response, as request logging does", async () => {
        await createServerlessApp({ server: { requestLogging: { enabled: true } } });
        const finished: string[] = [];
        await app.use((req: any, res: any, next: () => void) => {
          res.on('finish', () => finished.push(`${req.method} ${req.path} ${res.statusCode}`));
          res.once('close', () => finished.push('closed'));
          next();
        });
        app.get('/made', (_req: any, res: any) => {
          res.status(201).json({ made: true });
        });
        const invoke = invoker(app.getHandler());

        const reply = await invoke('/made');
        expect(reply.status).toBe(201);
        expect(finished).toEqual(['GET /made 201', 'closed']);
      });

      it('gives the client no error text from a failed request in production', async () => {
        await createServerlessApp();
        const logged = jest.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
        app.hooks.before('request', () => {
          throw new Error('connect ECONNREFUSED postgres://app:hunter2@db.internal');
        });
        app.get('/any', () => ({ ok: true }));
        const invoke = invoker(app.getHandler());
        const previous = process.env.NODE_ENV;
        try {
          process.env.NODE_ENV = 'production';
          const inProduction = await invoke('/any');
          expect(inProduction.status).toBe(500);
          const body = JSON.parse(inProduction.body);
          expect(body).toEqual({
            success: false,
            error: 'Internal server error',
            requestId: body.requestId,
          });
          expect(inProduction.body).not.toContain('hunter2');
          // The detail is in the log, with the id the client was given.
          const entry = logged.mock.calls.find(call => String(call[0]).includes('hunter2'));
          expect(entry).toBeDefined();
          expect((entry as any[])[2]).toMatchObject({ requestId: body.requestId });

          process.env.NODE_ENV = 'development';
          const inDevelopment = JSON.parse((await invoke('/any')).body);
          expect(inDevelopment.error).toBe('Internal server error');
          expect(inDevelopment.message).toContain('ECONNREFUSED');
        } finally {
          process.env.NODE_ENV = previous;
        }
      });

      it('gives the client no error text from a failed legacy direct route in production', async () => {
        await createServerlessApp();
        app.get('/report', () => {
          throw new Error("ENOENT: no such file or directory, open '/srv/app/reports/q3.csv'");
        });
        const invoke = invoker(app.getHandler());
        // The direct route table answers when the router no longer holds the route.
        UnifiedRouter.getInstance().clearAllRoutes();
        const previous = process.env.NODE_ENV;
        try {
          process.env.NODE_ENV = 'production';
          const inProduction = await invoke('/report');
          expect(inProduction.status).toBe(500);
          const body = JSON.parse(inProduction.body);
          expect(body).toEqual({
            success: false,
            error: 'Internal server error',
            requestId: body.requestId,
          });
          expect(typeof body.requestId).toBe('string');

          process.env.NODE_ENV = 'development';
          const inDevelopment = JSON.parse((await invoke('/report')).body);
          expect(inDevelopment).toEqual({
            success: false,
            error: "ENOENT: no such file or directory, open '/srv/app/reports/q3.csv'",
          });
        } finally {
          process.env.NODE_ENV = previous;
        }
      });
    });

    // Sign-in runs on Better Auth, which is given a Web Request built from the
    // request the runtime adapter made. better-auth is an optional peer that is
    // not installed here: a stand-in with the same module shape takes its
    // place (tests/fixtures/better-auth-fake) and records what it was handed.
    describe.each([
      ['createAuthMiddleware()', (config: any) => createAuthMiddleware(config)],
      ['auth()', (config: any) => auth(config)],
    ])('the auth routes of %s on AWS Lambda', (_name, install) => {
      const FAKE = path.resolve(__dirname, '../../fixtures/better-auth-fake/index.cjs');
      const fake: {
        instances: Array<{
          requests: Array<{ pathname: string; search: string; headers: Record<string, string> }>;
        }>;
        SESSION_COOKIE: string;
      } = require(FAKE);
      const config = {
        secret: 'a-secret-that-is-long-enough-for-tests',
        baseURL: 'https://app.example',
        providers: [{ id: 'github', clientId: 'client-id', clientSecret: 'client-secret' }],
      };
      let app: any;
      let handler: any;

      // An API Gateway REST API event: the path alone, the query string parsed
      const restEvent = (
        target: string,
        headers: Record<string, string> = {},
        method = 'GET'
      ): LambdaEvent => {
        const [eventPath, search = ''] = target.split('?');
        return {
          httpMethod: method,
          path: eventPath as string,
          queryStringParameters: search ? Object.fromEntries(new URLSearchParams(search)) : null,
          headers: { Host: 'app.example', 'X-Forwarded-Proto': 'https', ...headers },
          requestContext: { identity: { sourceIp: '203.0.113.9' } },
          body: null,
        } as LambdaEvent;
      };
      const start = async (server: Record<string, unknown> = {}) => {
        resetConfig();
        UnifiedRouter.reset();
        app = await createAppLambda({
          logger: { level: 'fatal' },
          autoDiscover: false,
          server: { requestLogging: { enabled: false }, ...server },
        });
        await app.use(install(config));
        app
          .get('/dashboard')
          .before(requireAuth())
          .handler((req: any) => ({ hello: req.auth.user.name }));
        handler = app.getHandler();
      };
      // Better Auth is loaded while the middleware installs; a request waits for it
      const betterAuth = () => fake.instances[fake.instances.length - 1]!;
      const invoke = (event: LambdaEvent) => handler(event, { awsRequestId: 'request-1' });

      beforeEach(() => {
        fake.instances.length = 0;
        forgetStartupWarnings();
        jest.spyOn(packageUtils, 'resolveUserPackage').mockReturnValue(FAKE);
      });

      afterEach(async () => {
        if (app) await closeApp(app);
        app = undefined;
        resetConfig();
        jest.restoreAllMocks();
      });

      it("hands Better Auth the query string of a REST API event, so a provider's callback completes", async () => {
        await start();

        const callback = await invoke(restEvent('/api/auth/callback/github?code=abc&state=xyz'));
        expect(betterAuth().requests).toHaveLength(1);
        expect(betterAuth().requests[0]).toMatchObject({
          pathname: '/api/auth/callback/github',
          search: '?code=abc&state=xyz',
        });
        expect(callback.statusCode).toBe(302);
        expect(callback.headers.Location ?? callback.headers.location).toBe('/dashboard');

        // The session cookie the callback set authenticates the next invocation
        const cookies: string[] = callback.multiValueHeaders['Set-Cookie'];
        const session = cookies.map(cookie => cookie.split('; ')[0]).find(c => /session/.test(c));
        expect(session).toBe(fake.SESSION_COOKIE);
        const guarded = await invoke(restEvent('/dashboard', { Cookie: session as string }));
        expect(guarded.statusCode).toBe(200);
        expect(JSON.parse(guarded.body)).toEqual({ hello: 'Ada' });
        expect((await invoke(restEvent('/dashboard'))).statusCode).toBe(401);

        // A sign-out link carries its callback URL in the query too
        const signOut = await invoke(
          restEvent(
            '/api/auth/signout?callbackUrl=%2Fbye',
            {
              Cookie: session as string,
              Origin: 'https://app.example',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            'POST'
          )
        );
        expect(signOut.statusCode).toBe(302);
        expect(signOut.headers.Location ?? signOut.headers.location).toBe('/bye');
      });

      it('with server.trustProxy set, gives Better Auth the address of the event and no header a client wrote', async () => {
        await start({ trustProxy: false });
        await invoke(restEvent('/api/auth/ok', { 'X-Forwarded-For': '198.51.100.7' }));

        const seen = betterAuth().requests[0]!.headers;
        expect(seen['x-moro-client-ip']).toBe('203.0.113.9');
        expect(seen['x-forwarded-for']).toBeUndefined();
      });
    });
  });

  // req.url is the request line's target: the path with its query string. A
  // REST API or load balancer event names the path alone and delivers the
  // query as parameters, so the adapter puts the two together again. Each
  // request line below is also sent to the Node server, whose req.url,
  // req.path and req.query are the reference.
  describe('req.url on AWS Lambda events', () => {
    const adapter = new AWSLambdaAdapter();
    const context = { awsRequestId: 'request-1' } as LambdaContext;
    const adapt = async (event: LambdaEvent | LambdaHttpApiEvent) => {
      const req: any = await adapter.adaptRequest(event, context);
      return { url: req.url, path: req.path, query: { ...req.query } };
    };

    let nodeApp: any;
    let port: number;
    beforeAll(async () => {
      resetConfig();
      nodeApp = await createApp({ logger: { level: 'fatal' }, server: { engine: 'node' } });
      nodeApp.get('/items', (req: any) => ({
        url: req.url,
        path: req.path,
        query: { ...req.query },
      }));
      port = createTestPort();
      await new Promise<void>(resolve => nodeApp.listen(port, '127.0.0.1', () => resolve()));
    });
    afterAll(async () => {
      await closeApp(nodeApp);
      resetConfig();
    });
    /** What the Node server reports for exactly this request line */
    const onNode = (target: string) =>
      new Promise<{ url: string; path: string; query: Record<string, string> }>(
        (resolve, reject) => {
          nodeHttp
            .get({ host: '127.0.0.1', port, path: target }, res => {
              let text = '';
              res.on('data', chunk => (text += chunk));
              res.on('end', () => resolve(JSON.parse(text)));
            })
            .on('error', reject);
        }
      );

    // API Gateway REST API (and payload format 1.0): names and values arrive
    // URL-decoded, in both the single-value and the multi-value map
    const restEvent = (
      single: Record<string, string> | null,
      multi: Record<string, string[]> | null
    ): LambdaEvent => ({
      httpMethod: 'GET',
      path: '/items',
      queryStringParameters: single,
      multiValueQueryStringParameters: multi,
      headers: { Host: 'api.example' },
      multiValueHeaders: { Host: ['api.example'] },
      requestContext: { identity: { sourceIp: '203.0.113.9' } },
      body: null,
    });
    // Application Load Balancer: names and values arrive as the client sent
    // them, still percent-encoded
    const albEvent = (query: Partial<LambdaEvent>): LambdaEvent => ({
      httpMethod: 'GET',
      path: '/items',
      requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:tg' } },
      body: null,
      ...query,
    });
    const httpApiEvent = (rawQueryString: string): LambdaHttpApiEvent => ({
      version: '2.0',
      routeKey: '$default',
      rawPath: '/items',
      rawQueryString,
      headers: { host: 'api.example' },
      requestContext: { http: { method: 'GET', path: '/items', sourceIp: '203.0.113.9' } },
      isBase64Encoded: false,
    });

    it.each([
      [
        'a REST API event with single-value parameters',
        '/items?page=2&sort=name',
        restEvent({ page: '2', sort: 'name' }, { page: ['2'], sort: ['name'] }),
        { page: '2', sort: 'name' },
      ],
      [
        'a REST API event with a repeated parameter',
        '/items?tag=a&tag=b&page=2',
        restEvent({ tag: 'b', page: '2' }, { tag: ['a', 'b'], page: ['2'] }),
        { tag: 'b', page: '2' },
      ],
      [
        'a REST API event whose values need encoding (space, &, =, non-ASCII)',
        '/items?q=a%20b%26c%3Dd&name=Zo%C3%AB&caf%C3%A9=1',
        restEvent(
          { q: 'a b&c=d', name: 'Zoë', café: '1' },
          { q: ['a b&c=d'], name: ['Zoë'], café: ['1'] }
        ),
        { q: 'a b&c=d', name: 'Zoë', café: '1' },
      ],
      [
        'a REST API event that has only the single-value map',
        '/items?q=a%20b&page=2',
        restEvent({ q: 'a b', page: '2' }, null),
        { q: 'a b', page: '2' },
      ],
      [
        'a load balancer event, whose values are still encoded',
        '/items?q=a%20b%26c&name=Zo%C3%AB',
        albEvent({
          queryStringParameters: { q: 'a%20b%26c', name: 'Zo%C3%AB' },
          headers: { host: 'lb.example' },
        }),
        // Decoded, as the Node server decodes them
        { q: 'a b&c', name: 'Zoë' },
      ],
      [
        'a load balancer event with + for a space, an escaped % and an empty value',
        '/items?q=a+b&rate=100%25&flag=&caf%C3%A9=1',
        albEvent({
          queryStringParameters: { q: 'a+b', rate: '100%25', flag: '', 'caf%C3%A9': '1' },
          headers: { host: 'lb.example' },
        }),
        { q: 'a b', rate: '100%', flag: '', café: '1' },
      ],
      [
        'a load balancer event with escapes that cannot be decoded beside one that can',
        '/items?q=%zz&rate=100%&name=%E0%A4%A&city=S%C3%A3o%20Paulo',
        albEvent({
          queryStringParameters: {
            q: '%zz',
            rate: '100%',
            name: '%E0%A4%A',
            city: 'S%C3%A3o%20Paulo',
          },
          headers: { host: 'lb.example' },
        }),
        // The first three are left as they were sent, by the same rule as on the Node server
        { q: '%zz', rate: '100%', name: '%E0%A4%A', city: 'São Paulo' },
      ],
      [
        'a load balancer event with multi-value parameters',
        '/items?tag=a%20x&tag=b&page=2',
        albEvent({
          multiValueQueryStringParameters: { tag: ['a%20x', 'b'], page: ['2'] },
          multiValueHeaders: { host: ['lb.example'] },
        }),
        { tag: 'b', page: '2' },
      ],
      [
        'a load balancer event whose repeated parameter ends on an encoded value',
        '/items?tag=a&tag=b%20y&q=x%26y',
        albEvent({
          multiValueQueryStringParameters: { tag: ['a', 'b%20y'], q: ['x%26y'] },
          multiValueHeaders: { host: ['lb.example'] },
        }),
        { tag: 'b y', q: 'x&y' },
      ],
    ])('is the path with its query string for %s', async (_name, target, event, query) => {
      const reference = await onNode(target);
      expect(reference).toEqual({ url: target, path: '/items', query });

      // req.url, req.path and req.query as on the Node server
      expect(await adapt(event)).toEqual(reference);
    });

    it('is the same for a REST API event and an HTTP API event of one request, and the bare path without a query', async () => {
      const target = '/items?tag=a&tag=b&q=x%20y';
      const reference = await onNode(target);
      // A repeated parameter has its last value on the Node server too
      expect(reference.query).toEqual({ tag: 'b', q: 'x y' });

      // An HTTP API event carries the raw query string: as it always was
      const httpApi = await adapt(httpApiEvent('tag=a&tag=b&q=x%20y'));
      expect(httpApi).toEqual({ url: target, path: '/items', query: { tag: 'b', q: 'x y' } });
      const rest = await adapt(restEvent({ tag: 'b', q: 'x y' }, { tag: ['a', 'b'], q: ['x y'] }));
      expect(rest).toEqual(httpApi);
      expect(rest).toEqual(reference);

      // No query: the path alone, with no `?` behind it
      const bare = { url: '/items', path: '/items', query: {} };
      expect(await onNode('/items')).toEqual(bare);
      expect(await adapt(restEvent(null, null))).toEqual(bare);
      expect(await adapt(albEvent({ queryStringParameters: {}, headers: {} }))).toEqual(bare);
      expect(
        await adapt(albEvent({ multiValueQueryStringParameters: {}, multiValueHeaders: {} }))
      ).toEqual(bare);
      expect(await adapt(httpApiEvent(''))).toEqual(bare);
    });

    // The runtimes that receive a whole URL parse its query with the parser
    // the Node server uses, so the awkward inputs come out the same too
    it.each([
      ['a plus sign, an escaped percent and an empty value', 'q=a+b&rate=100%25&flag='],
      ['an escape that cannot be decoded', 'name=%E0%A4%A&city=S%C3%A3o%20Paulo'],
      ['a key named __proto__', '__proto__=x&q=1'],
      ['a repeated key', 'tag=a&tag=b%20y'],
    ])('req.query from a URL matches the Node server: %s', async (_name, rawQuery) => {
      const reference = (await onNode(`/items?${rawQuery}`)).query;
      const own = (query: object) => JSON.parse(JSON.stringify({ ...query }));

      const httpApi: any = await adapter.adaptRequest(httpApiEvent(rawQuery), context);
      expect(own(httpApi.query)).toEqual(reference);

      const url = `https://api.example/items?${rawQuery}`;
      const edge: any = await new VercelEdgeAdapter().adaptRequest(new Request(url));
      expect(own(edge.query)).toEqual(reference);
      const worker: any = await new CloudflareWorkersAdapter().adaptRequest(new Request(url), {}, {
        waitUntil() {},
        passThroughOnException() {},
      } as any);
      expect(own(worker.query)).toEqual(reference);
    });
  });
});
