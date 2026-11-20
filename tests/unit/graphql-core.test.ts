// GraphQL Core Tests
import { describe, it, expect, afterEach } from '@jest/globals';
import { parse, getOperationAST, Kind } from 'graphql';
import { GraphQLCore, listGraphQLOperations } from '../../src/core/graphql/core.js';
import type { GraphQLOptions, GraphQLContext } from '../../src/core/graphql/types.js';

function mockResponse() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

const accountSchema = {
  typeDefs: `
    type Query { hello: String! whoami: String! }
    type Mutation { deleteAccount: String! }
  `,
  resolvers: {
    Query: {
      hello: () => 'hello',
      whoami: (_: unknown, __: unknown, ctx: GraphQLContext) => String(ctx.user),
    },
    Mutation: {
      deleteAccount: (_: unknown, __: unknown, ctx: GraphQLContext) =>
        `deleted account of ${String(ctx.user)}`,
    },
  },
};

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

  describe('Depth and complexity limits', () => {
    it('answers a document over a limit with a GraphQL error, not a failure', async () => {
      let resolved = 0;
      core = new GraphQLCore({
        typeDefs: `
          type Node { id: ID! child: Node! }
          type Query { node: Node! }
        `,
        resolvers: {
          Query: {
            node: () => {
              resolved++;
              const node: any = { id: '1' };
              node.child = node;
              return node;
            },
          },
        },
        enableJIT: false,
        maxDepth: 2,
        maxComplexity: 10,
      });
      await core.initialize();

      const res = mockResponse();
      await core.handleRequest(
        { method: 'POST', body: { query: '{ node { child { child { id } } } }' } } as any,
        res as any
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledTimes(1);
      const body = res.json.mock.calls[0][0] as any;
      expect(body.data).toBeUndefined();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toBe('Query depth of 4 exceeds maximum allowed depth of 2');
      expect(resolved).toBe(0);

      const ok = mockResponse();
      await core.handleRequest(
        { method: 'POST', body: { query: '{ node { id } }' } } as any,
        ok as any
      );
      expect((ok.json.mock.calls[0][0] as any).data).toEqual({ node: { id: '1' } });
    });
  });

  describe('Operations over GET', () => {
    let deleted: number;

    beforeEach(async () => {
      deleted = 0;
      core = new GraphQLCore({
        typeDefs: accountSchema.typeDefs,
        resolvers: {
          Query: { hello: () => 'hello', whoami: () => 'me' },
          Mutation: {
            deleteAccount: () => {
              deleted++;
              return 'deleted';
            },
          },
        },
      });
      await core.initialize();
    });

    it('rejects a mutation sent over GET with 405 and does not execute it', async () => {
      const res = mockResponse();
      await core.handleRequest(
        { method: 'GET', query: { query: 'mutation { deleteAccount }' } } as any,
        res as any
      );

      expect(deleted).toBe(0);
      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
      expect(res.json).toHaveBeenCalledWith({
        errors: [{ message: 'GraphQL mutations and subscriptions must be sent with POST' }],
      });
    });

    it('rejects a mutation selected by operationName over GET', async () => {
      const res = mockResponse();
      await core.handleRequest(
        {
          method: 'GET',
          query: {
            query: 'query Safe { hello } mutation Danger { deleteAccount }',
            operationName: 'Danger',
          },
        } as any,
        res as any
      );

      expect(deleted).toBe(0);
      expect(res.status).toHaveBeenCalledWith(405);
    });

    it('does not build the context for a rejected GET mutation', async () => {
      await core.cleanup();
      const contextFactory = jest.fn(async (request: any, response: any) => ({
        request,
        response,
      }));
      core = new GraphQLCore({ ...accountSchema, context: contextFactory });
      await core.initialize();

      const res = mockResponse();
      await core.handleRequest(
        { method: 'GET', query: { query: 'mutation { deleteAccount }' } } as any,
        res as any
      );
      expect(res.status).toHaveBeenCalledWith(405);
      expect(contextFactory).not.toHaveBeenCalled();
    });

    it('executes queries over GET, including with a selected operation', async () => {
      const res = mockResponse();
      await core.handleRequest({ method: 'GET', query: { query: '{ hello }' } } as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { hello: 'hello' } }));

      const res2 = mockResponse();
      await core.handleRequest(
        {
          method: 'GET',
          query: {
            query: 'query Safe { hello } mutation Danger { deleteAccount }',
            operationName: 'Safe',
          },
        } as any,
        res2 as any
      );
      expect(res2.status).toHaveBeenCalledWith(200);
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ data: { hello: 'hello' } }));
      expect(deleted).toBe(0);
    });

    it('is not confused by the word "mutation" inside a query', async () => {
      const res = mockResponse();
      await core.handleRequest(
        {
          method: 'GET',
          query: { query: '# mutation { deleteAccount }\nquery mutation { mutation: hello }' },
        } as any,
        res as any
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { mutation: 'hello' } })
      );
    });

    it('executes mutations over POST', async () => {
      const res = mockResponse();
      await core.handleRequest(
        { method: 'POST', body: { query: 'mutation { deleteAccount }' } } as any,
        res as any
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(deleted).toBe(1);
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
        context: (req: any, res: any) => ({
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

  describe('Introspection default by environment', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const introspection = { method: 'POST', body: { query: '{ __schema { types { name } } }' } };
    const schema = {
      typeDefs: `type Query { test: String }`,
      resolvers: { Query: { test: () => 'test' } },
    };

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    async function statusFor(options: { enableIntrospection?: boolean }, nodeEnv: string) {
      process.env.NODE_ENV = nodeEnv;
      core = new GraphQLCore({ ...schema, ...options });
      await core.initialize();
      const res = mockResponse();
      await core.handleRequest(introspection as any, res as any);
      return res.status.mock.calls[0]?.[0];
    }

    it('is enabled outside production when not configured', async () => {
      expect(await statusFor({}, 'development')).toBe(200);
    });

    it('is disabled in production when not configured', async () => {
      expect(await statusFor({}, 'production')).toBe(400);
    });

    it('explicit true wins in production', async () => {
      expect(await statusFor({ enableIntrospection: true }, 'production')).toBe(200);
    });

    it('explicit false wins outside production', async () => {
      expect(await statusFor({ enableIntrospection: false }, 'development')).toBe(400);
    });

    it('does not block ordinary queries in production', async () => {
      process.env.NODE_ENV = 'production';
      core = new GraphQLCore(schema);
      await core.initialize();
      const res = mockResponse();
      await core.handleRequest({ method: 'POST', body: { query: '{ test }' } } as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { test: 'test' } }));
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

    it('loads every external file at an exact version with its digest', () => {
      const html = core.getPlaygroundHTML();
      const external = [
        ...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(https?:[^"]+)"[^>]*>/g),
      ];
      expect(external).toHaveLength(4);

      for (const [tag, url] of external) {
        // name@major.minor.patch, never a range such as @2 or @18
        expect(url).toMatch(/^https:\/\/unpkg\.com\/[a-z-]+@\d+\.\d+\.\d+\//);
        expect(tag).toMatch(/\bintegrity="sha384-[A-Za-z0-9+/]{64}"/);
        expect(tag).toContain('crossorigin="anonymous"');
      }
    });

    it('writes the endpoint path as a script literal', async () => {
      const custom = new GraphQLCore({
        typeDefs: `type Query { test: String }`,
        path: `/api'</script><script>alert(1)</script>`,
      });
      const html = custom.getPlaygroundHTML();
      expect(html).not.toContain('<script>alert(1)');
      expect(html.match(/<\/script>/g)).toHaveLength(4);
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
      expect(stats.jit!.cacheSize).toBe(0);
    });
  });

  describe('listGraphQLOperations', () => {
    const documents = [
      '{ a }',
      'query { a }',
      'query Named { a }',
      'mutation { a }',
      'mutation Named($id: ID = "mutation") @dir(if: true) { a(input: { b: "}" }) }',
      'subscription OnEvent { a }',
      'query A { a } mutation B { b } subscription C { c }',
      'fragment mutation on T { a } query Q { ...mutation }',
      'query mutation { a }',
      'mutation query { a }',
      '# mutation { a }\n{ a }',
      '{ a(text: "} mutation { b }") }',
      '{ a(text: """\n} mutation { b }\n""") }',
      '{ a(text: "\\" } mutation { b }") }',
      'query Q($v: In = { mutation: 1 }) { a(x: $v) }',
      '﻿  ,,, mutation,M,{ a }',
      '{ a { b { c } } } mutation M { d }',
    ];

    it.each(documents)('agrees with the graphql parser for %j', source => {
      const expected = parse(source)
        .definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION)
        .map(definition => {
          const operation = getOperationAST(
            { kind: Kind.DOCUMENT, definitions: [definition] },
            undefined
          );
          return operation?.name
            ? { type: String(operation.operation), name: operation.name.value }
            : { type: String(operation?.operation) };
        });

      expect(listGraphQLOperations(source)).toEqual(expected);
    });

    it('recognises an operation that follows a description string', () => {
      expect(listGraphQLOperations('"about" mutation M { a }')).toEqual([
        { type: 'mutation', name: 'M' },
      ]);
    });

    it('returns null for lexically malformed documents', () => {
      expect(listGraphQLOperations('{ a(text: "unterminated) }')).toBeNull();
      expect(listGraphQLOperations('{ a(text: """unterminated) }')).toBeNull();
      expect(listGraphQLOperations('{ a ')).toBeNull();
      expect(listGraphQLOperations('} mutation { a }')).toBeNull();
    });
  });
});
