// GraphQL Core Tests
import { describe, it, expect, afterEach } from '@jest/globals';
import { GraphQLCore } from '../../src/core/graphql/core';
import type { GraphQLOptions } from '../../src/core/graphql/types';

describe('GraphQL Core', () => {
  let core: GraphQLCore;

  afterEach(async () => {
    if (core) {
      await core.cleanup();
    }
  });

  describe('Initialization', () => {
    it('should initialize with default adapter', async () => {
      const options: GraphQLOptions = {
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
      };

      core = new GraphQLCore(options);
      await core.initialize();

      expect(core.getSchema()).toBeDefined();
    });

    it('should initialize with custom adapter', async () => {
      const mockAdapter = {
        initialize: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn(),
        getIntrospection: jest.fn(),
        getSchemaSDL: jest.fn(),
        getSchema: jest.fn(),
        getStats: jest.fn(),
        cleanup: jest.fn(),
      };

      const options: GraphQLOptions = {
        adapter: mockAdapter,
        typeDefs: `type Query { test: String }`,
      };

      core = new GraphQLCore(options);
      await core.initialize();

      expect(mockAdapter.initialize).toHaveBeenCalled();
    });

    it('should use options from constructor', async () => {
      core = new GraphQLCore({
        typeDefs: `type Query { hello: String }`,
        resolvers: { Query: { hello: () => 'world' } },
        enableJIT: true,
        enablePlayground: false,
      });

      await core.initialize();

      const stats = core.getStats();
      expect(stats).toBeDefined();
    });
  });

  describe('HTTP Request Handling', () => {
    beforeEach(async () => {
      core = new GraphQLCore({
        typeDefs: `
          type Query {
            hello(name: String): String!
          }
        `,
        resolvers: {
          Query: {
            hello: (_: any, args: any) => `Hello ${args.name || 'World'}!`,
          },
        },
      });
      await core.initialize();
    });

    it('should handle POST GraphQL requests', async () => {
      const req = {
        method: 'POST',
        body: {
          query: '{ hello }',
        },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { hello: 'Hello World!' },
        })
      );
    });

    it('should handle GET GraphQL requests with query params', async () => {
      const req = {
        method: 'GET',
        query: {
          query: '{ hello(name: "Alice") }',
        },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { hello: 'Hello Alice!' },
        })
      );
    });

    it('should reject invalid requests', async () => {
      const req = {
        method: 'POST',
        body: {},
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              message: 'Invalid GraphQL request',
            }),
          ]),
        })
      );
    });

    it('should handle variables in POST requests', async () => {
      const req = {
        method: 'POST',
        body: {
          query: 'query($name: String) { hello(name: $name) }',
          variables: { name: 'Bob' },
        },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { hello: 'Hello Bob!' },
        })
      );
    });
  });

  describe('Context Handling', () => {
    it('should use custom context factory', async () => {
      let capturedContext: any;

      core = new GraphQLCore({
        typeDefs: `type Query { contextTest: String }`,
        resolvers: {
          Query: {
            contextTest: (_: any, __: any, ctx: any) => {
              capturedContext = ctx;
              return 'ok';
            },
          },
        },
        context: (req, res) => ({
          request: req,
          response: res,
          customValue: 'test-value',
        }),
      });

      await core.initialize();

      const req = {
        method: 'POST',
        body: { query: '{ contextTest }' },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(capturedContext).toBeDefined();
      expect(capturedContext.customValue).toBe('test-value');
    });

    it('should provide default context when no factory provided', async () => {
      let capturedContext: any;

      core = new GraphQLCore({
        typeDefs: `type Query { test: String }`,
        resolvers: {
          Query: {
            test: (_: any, __: any, ctx: any) => {
              capturedContext = ctx;
              return 'ok';
            },
          },
        },
      });

      await core.initialize();

      const req = {
        method: 'POST',
        body: { query: '{ test }' },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(capturedContext).toBeDefined();
      expect(capturedContext.request).toBe(req);
      expect(capturedContext.response).toBe(res);
    });
  });

  describe('Introspection', () => {
    beforeEach(async () => {
      core = new GraphQLCore({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
      });
      await core.initialize();
    });

    it('should allow introspection by default', async () => {
      const req = {
        method: 'POST',
        body: {
          query: '{ __schema { types { name } } }',
        },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.any(Object),
        })
      );
    });

    it('should block introspection when disabled', async () => {
      await core.cleanup();

      core = new GraphQLCore({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableIntrospection: false,
      });
      await core.initialize();

      const req = {
        method: 'POST',
        body: {
          query: '{ __schema { types { name } } }',
        },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              message: 'GraphQL introspection is disabled',
            }),
          ]),
        })
      );
    });

    it('should provide introspection data', () => {
      const introspection = core.getIntrospection();
      expect(introspection).toBeDefined();
    });

    it('should provide schema SDL', () => {
      const sdl = core.getSchemaSDL();
      expect(sdl).toBeDefined();
      expect(sdl).toContain('type Query');
    });
  });

  describe('GraphQL Playground', () => {
    beforeEach(async () => {
      core = new GraphQLCore({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        path: '/graphql',
      });
      await core.initialize();
    });

    it('should generate playground HTML', () => {
      const html = core.getPlaygroundHTML();
      expect(html).toBeDefined();
      expect(html).toContain('GraphQL Playground');
      expect(html).toContain('/graphql');
    });

    it('should include GraphiQL script', () => {
      const html = core.getPlaygroundHTML();
      expect(html).toContain('graphiql');
    });
  });

  describe('Statistics', () => {
    it('should provide adapter statistics', async () => {
      core = new GraphQLCore({
        typeDefs: `
          type Query { q: String }
          type Mutation { m: String }
        `,
        resolvers: {
          Query: { q: () => 'q' },
          Mutation: { m: () => 'm' },
        },
      });
      await core.initialize();

      const stats = core.getStats();
      expect(stats).toBeDefined();
      expect(stats.schema).toBeDefined();
      expect(stats.schema.queries).toBeGreaterThanOrEqual(1);
      expect(stats.schema.mutations).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup adapter resources', async () => {
      core = new GraphQLCore({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableJIT: true,
      });
      await core.initialize();

      // Execute query to populate cache
      const req = {
        method: 'POST',
        body: { query: '{ test }' },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await core.handleRequest(req, res);

      // Cleanup
      await core.cleanup();

      // Stats should show empty cache
      const stats = core.getStats();
      expect(stats.jit.cacheSize).toBe(0);
    });
  });
});

