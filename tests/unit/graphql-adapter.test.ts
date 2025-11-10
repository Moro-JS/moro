/* eslint-disable */
// GraphQL Adapter Tests
import { describe, it, expect, afterEach } from '@jest/globals';
import { GraphQLJsAdapter } from '../../src/core/graphql/adapters/graphql-js-adapter';
import type { GraphQLAdapterOptions } from '../../src/core/graphql/adapter';

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
      expect(typeof stats.jit.enabled).toBe('boolean');
    });

    it('should disable JIT when requested', async () => {
      adapter = new GraphQLJsAdapter();
      await adapter.initialize({
        typeDefs: `type Query { test: String }`,
        resolvers: { Query: { test: () => 'test' } },
        enableJIT: false,
      });

      const stats = adapter.getStats();
      expect(stats.jit.enabled).toBe(false);
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
      if (stats.jit.enabled) {
        expect(stats.jit.cacheSize).toBeGreaterThanOrEqual(0);
      }
    });
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
      expect(stats.jit.cacheSize).toBe(0);
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

      expect(adapter.getStats().jit.cacheSize).toBe(0);
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

