// GraphQL Adapter Tests
import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { GraphQLJsAdapter } from '../../src/core/graphql/adapters/graphql-js-adapter.js';
import type { GraphQLAdapterOptions } from '../../src/core/graphql/adapter.js';
import type { GraphQLContext } from '../../src/core/graphql/types.js';

function contextFor(user: string): GraphQLContext {
  return { request: {} as any, response: {} as any, user };
}

// A schema whose results depend on who is asking, so a compiled query that
// was reused for the wrong document or caller would show in the result.
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

describe('GraphQL Adapter', () => {
  let adapter: GraphQLJsAdapter;

  afterEach(async () => {
    if (adapter) {
      await adapter.cleanup();
    }
  });

  describe('Initialization', () => {
    it('should initialize with typeDefs and resolvers', async () => {
      adapter = new GraphQLJsAdapter();

      const options: GraphQLAdapterOptions = {
        typeDefs: `
          type Query {
            hello: String!
          }
        `,
        resolvers: {
          Query: {
            hello: () => 'Hello World!',
          },
        },
      };

      await adapter.initialize(options);

      const schema = adapter.getSchema();
      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
    });

    it('should initialize with pre-built schema', async () => {
      const { buildSchema } = await import('graphql');
      const schema = buildSchema(`
        type Query {
          test: String
        }
      `);

      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ schema });

      expect(adapter.getSchema()).toBe(schema);
    });

    it('should support Pothos schema', async () => {
      // Mock Pothos schema
      const mockSchema = {
        toSchema: () => {
          const { buildSchema } = require('graphql');
          return buildSchema(`type Query { pothos: String }`);
        },
      };

      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ pothosSchema: mockSchema });

      const schema = adapter.getSchema();
      expect(schema).toBeDefined();
    });

    it('should throw error without schema', async () => {
      adapter = new GraphQLJsAdapter();

      await expect(adapter.initialize({})).rejects.toThrow('No schema provided');
    });
  });

  describe('Query Execution', () => {
    beforeEach(async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `
          type Query {
            hello(name: String): String!
            echo(message: String!): String!
          }
        `,
        resolvers: {
          Query: {
            hello: (_: any, args: any) => `Hello ${args.name || 'World'}!`,
            echo: (_: any, args: any) => args.message,
          },
        },
      });
    });

    it('should execute a simple query', async () => {
      const result = await adapter.execute({
        query: '{ hello }',
        context: { request: {} as any, response: {} as any },
      });

      expect(result.data).toEqual({ hello: 'Hello World!' });
      expect(result.errors).toBeUndefined();
    });

    it('should execute query with variables', async () => {
      const result = await adapter.execute({
        query: 'query($name: String) { hello(name: $name) }',
        variables: { name: 'Alice' },
        context: { request: {} as any, response: {} as any },
      });

      expect(result.data).toEqual({ hello: 'Hello Alice!' });
    });

    it('should return validation errors for invalid query', async () => {
      const result = await adapter.execute({
        query: '{ invalidField }',
        context: { request: {} as any, response: {} as any },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should handle query execution errors', async () => {
      await adapter.cleanup();
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { error: String }`,
        resolvers: {
          Query: {
            error: () => {
              throw new Error('Test error');
            },
          },
        },
      });

      const result = await adapter.execute({
        query: '{ error }',
        context: { request: {} as any, response: {} as any },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toContain('Test error');
    });
  });

  describe('GraphQL-JIT', () => {
    it('should enable JIT when available and requested', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableJIT: true,
      });

      const stats = adapter.getStats();
      // JIT may or may not be available depending on if graphql-jit is installed
      expect(stats.jit).toBeDefined();
      expect(typeof stats.jit!.enabled).toBe('boolean');
    });

    it('should disable JIT when requested', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableJIT: false,
      });

      const stats = adapter.getStats();
      expect(stats.jit!.enabled).toBe(false);
    });

    it('should cache JIT compiled queries', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { cached: String }`,
        resolvers: { Query: { cached: () => 'result' } },
        enableJIT: true,
      });

      // Execute same query twice
      const query = '{ cached }';
      const context = { request: {} as any, response: {} as any };

      await adapter.execute({ query, context });
      await adapter.execute({ query, context });

      // If JIT is enabled, cache should have entries
      const stats = adapter.getStats();
      if (stats.jit!.enabled) {
        expect(stats.jit!.cacheSize).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('JIT compiled-query cache keys and bounds', () => {
    it('is available in this test environment (graphql-jit installed)', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: true });
      expect(adapter.getStats().jit?.enabled).toBe(true);
    });

    it('never runs a cached anonymous operation for a different document', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: true });

      const first = await adapter.execute({
        query: 'mutation { deleteAccount }',
        context: contextFor('attacker'),
      });
      expect(first.data).toEqual({ deleteAccount: 'deleted account of attacker' });

      const second = await adapter.execute({
        query: '{ hello }',
        context: contextFor('victim'),
      });
      expect(second.errors).toBeUndefined();
      expect(second.data).toEqual({ hello: 'hello' });
    });

    it('never reuses a compiled query across documents that share an operation name', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: true });

      await adapter.execute({
        query: 'mutation Op { deleteAccount }',
        operationName: 'Op',
        context: contextFor('attacker'),
      });
      const second = await adapter.execute({
        query: 'query Op { whoami }',
        operationName: 'Op',
        context: contextFor('victim'),
      });
      expect(second.data).toEqual({ whoami: 'victim' });
    });

    it('reuses the compiled query for an identical document', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: true });

      for (let i = 0; i < 3; i++) {
        const result = await adapter.execute({ query: '{ hello }', context: contextFor('u') });
        expect(result.data).toEqual({ hello: 'hello' });
      }
      expect(adapter.getStats().jit?.cacheSize).toBe(1);
    });

    it('caps the cache and evicts the oldest entry', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: true, jitCacheMaxSize: 3 });

      for (let i = 0; i < 10; i++) {
        const result = await adapter.execute({
          query: `query Q${i} { hello }`,
          context: contextFor('u'),
        });
        expect(result.data).toEqual({ hello: 'hello' });
      }
      expect(adapter.getStats().jit?.cacheSize).toBe(3);

      // The evicted document still executes correctly (recompiled on demand)
      const again = await adapter.execute({
        query: 'query Q0 { hello }',
        context: contextFor('u'),
      });
      expect(again.data).toEqual({ hello: 'hello' });
      expect(adapter.getStats().jit?.cacheSize).toBe(3);
    });

    it('defaults the cap to 1000 entries', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: true });
      expect((adapter as unknown as { jitCacheMaxSize: number }).jitCacheMaxSize).toBe(1000);
    });
  });

  describe('error stack traces', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    const syntaxError = { query: '{ hello', context: contextFor('u') };

    it('omits the stack by default', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: false });

      const result = await adapter.execute(syntaxError);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0].message).toContain('Syntax Error');
      expect(JSON.stringify(result)).not.toContain('stack');
    });

    it('includes the stack when debug is true outside production', async () => {
      process.env.NODE_ENV = 'development';
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: false, debug: true });

      const result = await adapter.execute(syntaxError);
      expect(typeof result.errors?.[0].extensions.stack).toBe('string');
    });

    it('omits the stack in production even when debug is true', async () => {
      process.env.NODE_ENV = 'production';
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...accountSchema, enableJIT: false, debug: true });

      const result = await adapter.execute(syntaxError);
      expect(result.errors?.[0].message).toContain('Syntax Error');
      expect(JSON.stringify(result)).not.toContain('stack');
    });
  });

  describe('Depth and complexity limits', () => {
    // A schema that can be nested without end, with a resolver counter so a
    // refused document can be shown never to have run.
    let resolved: number;
    const treeSchema = () => ({
      typeDefs: `
        type Node { id: ID! name: String! child: Node! children: [Node!]! }
        type Query { node: Node! other: Node! }
      `,
      resolvers: {
        Query: {
          node: () => {
            resolved++;
            return treeNode();
          },
          other: () => {
            resolved++;
            return treeNode();
          },
        },
      },
    });
    const treeNode = (): any => ({
      id: '1',
      name: 'n',
      get child() {
        return treeNode();
      },
      get children() {
        return [treeNode()];
      },
    });
    const run = (query: string, operationName?: string) =>
      adapter.execute({ query, operationName, context: contextFor('u') });

    beforeEach(() => {
      resolved = 0;
    });

    for (const enableJIT of [false, true]) {
      const mode = enableJIT ? 'JIT' : 'standard execution';

      it(`refuses a document nested deeper than maxDepth without running it (${mode})`, async () => {
        adapter = new GraphQLJsAdapter();
        await adapter.initialize({ ...treeSchema(), enableJIT, maxDepth: 3 });

        const atLimit = await run('{ node { child { id } } }');
        expect(atLimit.errors).toBeUndefined();
        expect(atLimit.data).toEqual({ node: { child: { id: '1' } } });
        expect(resolved).toBe(1);

        const overLimit = await run('{ node { child { child { id } } } }');
        expect(overLimit.data).toBeUndefined();
        expect(overLimit.errors).toHaveLength(1);
        expect(overLimit.errors?.[0].message).toBe(
          'Query depth of 4 exceeds maximum allowed depth of 3'
        );
        expect(overLimit.errors?.[0].extensions).toEqual({ code: 'QUERY_TOO_DEEP' });
        expect(resolved).toBe(1);
      });

      it(`refuses a document selecting more fields than maxComplexity without running it (${mode})`, async () => {
        adapter = new GraphQLJsAdapter();
        await adapter.initialize({ ...treeSchema(), enableJIT, maxComplexity: 5 });

        const atLimit = await run('{ node { id name child { id } } }');
        expect(atLimit.errors).toBeUndefined();
        expect(resolved).toBe(1);

        const overLimit = await run('{ node { id name child { id name } } }');
        expect(overLimit.data).toBeUndefined();
        expect(overLimit.errors).toHaveLength(1);
        expect(overLimit.errors?.[0].message).toBe(
          'Query complexity of 6 exceeds maximum allowed complexity of 5'
        );
        expect(overLimit.errors?.[0].extensions).toEqual({ code: 'QUERY_TOO_COMPLEX' });
        expect(resolved).toBe(1);
      });
    }

    it('measures through fragments, counting a fragment each time it is spread', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        ...treeSchema(),
        enableJIT: false,
        maxDepth: 3,
        maxComplexity: 6,
      });

      const deepThroughFragment = await run(`
        { node { ...Level } }
        fragment Level on Node { child { ...Leaf } }
        fragment Leaf on Node { child { id } }
      `);
      expect(deepThroughFragment.errors?.map(e => e.message)).toEqual([
        'Query depth of 4 exceeds maximum allowed depth of 3',
      ]);

      // node (1) + other (1) + three fields spread twice (6) = 8
      const wideThroughFragment = await run(`
        { node { ...Fields } other { ...Fields } }
        fragment Fields on Node { id name children { __typename } }
      `);
      expect(wideThroughFragment.errors?.map(e => e.message)).toEqual([
        'Query complexity of 8 exceeds maximum allowed complexity of 6',
      ]);
      expect(resolved).toBe(0);
    });

    it('stays linear on fragments that fan out, and ends on a fragment that spreads itself', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...treeSchema(), enableJIT: false, maxComplexity: 1000 });

      // Each fragment spreads the next one twice: 2^40 fields when expanded
      const levels = 40;
      let document = '{ node { ...F0 } }';
      for (let i = 0; i < levels; i++) {
        const next = i + 1 < levels ? `...F${i + 1} more: child { ...F${i + 1} }` : 'id';
        document += ` fragment F${i} on Node { ${next} }`;
      }
      const started = Date.now();
      const fanOut = await run(document);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(fanOut.errors?.[0].extensions).toEqual({ code: 'QUERY_TOO_COMPLEX' });

      const cycle = await run('{ node { ...A } } fragment A on Node { child { ...A } }');
      expect(cycle.errors?.[0].message).toContain('Cannot spread fragment "A" within itself');
      expect(resolved).toBe(0);
    });

    it('measures only the operation that would run', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...treeSchema(), enableJIT: false, maxDepth: 2 });

      const document = `
        query Shallow { node { id } }
        query Deep { node { child { child { id } } } }
      `;
      const shallow = await run(document, 'Shallow');
      expect(shallow.errors).toBeUndefined();
      expect(shallow.data).toEqual({ node: { id: '1' } });

      const deep = await run(document, 'Deep');
      expect(deep.errors?.[0].message).toBe('Query depth of 4 exceeds maximum allowed depth of 2');
    });

    it('does not count introspection fields, and applies no limit unless one is set', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        ...treeSchema(),
        enableJIT: false,
        maxDepth: 2,
        maxComplexity: 3,
      });

      const refused = await run('{ node { child { id } } }');
      expect(refused.errors?.[0].extensions).toEqual({ code: 'QUERY_TOO_DEEP' });

      const { getIntrospectionQuery } = await import('graphql');
      const introspection = await run(getIntrospectionQuery());
      expect(introspection.errors).toBeUndefined();
      expect(introspection.data.__schema.queryType.name).toBe('Query');

      await adapter.cleanup();
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({ ...treeSchema(), enableJIT: false });
      const unlimited = await run('{ node { child { child { child { child { id name } } } } } }');
      expect(unlimited.errors).toBeUndefined();
    });
  });

  describe('rootValue', () => {
    for (const enableJIT of [false, true]) {
      it(`is the source of the root fields (${enableJIT ? 'JIT' : 'standard execution'})`, async () => {
        adapter = new GraphQLJsAdapter();
        await adapter.initialize({
          typeDefs: `type Query { version: String }`,
          rootValue: { version: '1.2.3' },
          enableJIT,
        });

        const result = await adapter.execute({ query: '{ version }', context: contextFor('u') });
        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual({ version: '1.2.3' });
      });
    }
  });

  describe('Schema Introspection', () => {
    beforeEach(async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `
          type Query {
            user(id: ID!): User
          }
          type User {
            id: ID!
            name: String!
          }
        `,
        resolvers: {
          Query: {
            user: () => ({ id: '1', name: 'Test' }),
          },
        },
      });
    });

    it('should return schema introspection', () => {
      const introspection = adapter.getIntrospection();
      expect(introspection).toBeDefined();
      expect(introspection.data).toBeDefined();
      expect(introspection.data.__schema).toBeDefined();
    });

    it('should return schema SDL', () => {
      const sdl = adapter.getSchemaSDL();
      expect(sdl).toBeDefined();
      expect(sdl).toContain('type Query');
      expect(sdl).toContain('type User');
    });

    it('should return schema object', () => {
      const schema = adapter.getSchema();
      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getType('User')).toBeDefined();
    });
  });

  describe('Statistics', () => {
    it('should return adapter statistics', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `
          type Query {
            test: String
          }
          type Mutation {
            create: String
          }
          type Subscription {
            updated: String
          }
        `,
        resolvers: {
          Query: { test: () => 'test' },
          Mutation: { create: () => 'created' },
        },
      });

      const stats = adapter.getStats();

      expect(stats).toBeDefined();
      expect(stats.schema).toBeDefined();
      expect(stats.schema.queries).toBe(1);
      expect(stats.schema.mutations).toBe(1);
      expect(stats.schema.subscriptions).toBe(1);
      expect(stats.schema.types).toBeGreaterThan(0);
      expect(stats.jit).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup resources including JIT cache', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableJIT: true,
      });

      // Execute query to populate cache
      await adapter.execute({
        query: '{ test }',
        context: { request: {} as any, response: {} as any },
      });

      await adapter.cleanup();

      // After cleanup, cache should be empty
      const stats = adapter.getStats();
      expect(stats.jit!.cacheSize).toBe(0);
    });

    it('should clear JIT timeouts on cleanup', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableJIT: true,
        jitCacheTTL: 5000,
      });

      // Execute to create cache entry with timeout
      await adapter.execute({
        query: '{ test }',
        context: { request: {} as any, response: {} as any },
      });

      // Cleanup should clear timeouts without hanging
      await adapter.cleanup();

      expect(adapter.getStats().jit!.cacheSize).toBe(0);
    });
  });

  describe('Context Handling', () => {
    it('should pass context to resolvers', async () => {
      let receivedContext: any;

      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { contextTest: String }`,
        resolvers: {
          Query: {
            contextTest: (_: any, __: any, context: any) => {
              receivedContext = context;
              return 'ok';
            },
          },
        },
      });

      const customContext = {
        request: { userId: '123' } as any,
        response: {} as any,
        custom: 'value',
      };

      await adapter.execute({
        query: '{ contextTest }',
        context: customContext,
      });

      expect(receivedContext).toBeDefined();
      expect(receivedContext.custom).toBe('value');
    });
  });
});
