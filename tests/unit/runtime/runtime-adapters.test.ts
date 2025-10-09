// Runtime Adapters Unit Tests
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  NodeRuntimeAdapter,
  VercelEdgeAdapter,
  AWSLambdaAdapter,
  CloudflareWorkersAdapter,
  createRuntimeAdapter,
} from '../../../src/core/runtime/index.js';
import type {
  LambdaEvent,
  LambdaContext,
  WorkersEnv,
  WorkersContext,
} from '../../../src/core/runtime/index.js';
import { IncomingMessage, ServerResponse } from 'http';

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
});
